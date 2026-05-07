// 自动识别"意外分段"录像并合并的逻辑。
//
// 触发条件：同房间，相邻两段之间的 ended_at → started_at 间隔 < GAP_SEC（默认 180s）。
// 整条会话沿这条规则向前向后扩张到所有同 session 段，按 started_at 升序返回。
//
// 合并产物：concat 后的 .flv（无损 -c copy）+ offset 合并的 .xml 弹幕，落盘 dataDir/merged/<seedId>/。
import { mkdirSync, existsSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { concatLossless, probeDuration } from '../ffmpeg.js';
import { mergeXmls, guessXmlPath } from '../danmaku.js';

export const DEFAULT_GAP_SEC = 180;     // 3 分钟

const findSameRoomEnded = db.prepare(`
  SELECT * FROM recordings
  WHERE room_id = ? AND ended_at IS NOT NULL
  ORDER BY started_at ASC
`);
const findStillRecording = db.prepare(`
  SELECT id, started_at FROM recordings
  WHERE room_id = ? AND ended_at IS NULL
    AND started_at >= ? AND started_at < ? + ?
  LIMIT 1
`);

/**
 * 找出与 seed recording 同一会话的相邻段（含自身），按 started_at 升序。
 *
 * 例：seed=#10，房间内有 #8(11:00-11:30), #9(11:31-12:00), #10(12:01-12:30), #11(12:32-...)
 * 默认 gap=180 → 全部 4 段都属于同一会话。
 */
export function findMergeCandidates(seedId, gapSec = DEFAULT_GAP_SEC) {
  const seed = db.prepare(`SELECT * FROM recordings WHERE id = ?`).get(seedId);
  if (!seed) throw new Error(`recording ${seedId} not found`);
  const allSorted = findSameRoomEnded.all(seed.room_id);
  // 找到 seed 的索引
  const seedIdx = allSorted.findIndex(r => r.id === seedId);
  if (seedIdx < 0) return [seed];

  // 向前扩
  const chain = [allSorted[seedIdx]];
  for (let i = seedIdx - 1; i >= 0; i--) {
    const cur = allSorted[i];
    const next = chain[0];
    if (next.started_at - cur.ended_at <= gapSec) chain.unshift(cur);
    else break;
  }
  // 向后扩
  for (let i = seedIdx + 1; i < allSorted.length; i++) {
    const cur = allSorted[i];
    const last = chain[chain.length - 1];
    if (cur.started_at - last.ended_at <= gapSec) chain.push(cur);
    else break;
  }
  return chain;
}

/**
 * 检查同房间是否有还在录的、且与 chain 相邻的下一段。
 * 用于 worker：如果有，应该 defer 等它录完再合并上传，不然丢一段。
 */
export function findStillRecordingNext(chain, gapSec = DEFAULT_GAP_SEC) {
  const last = chain[chain.length - 1];
  return findStillRecording.get(last.room_id, last.ended_at, last.ended_at, gapSec);
}

/**
 * 合并 chain 里多段录像为一个 .flv + 一个 .xml。
 * @param chain 已按 started_at 排序的 recordings
 * @param onProgress(phase, percent)
 * @returns { flvPath, xmlPath, durationSec, sizeBytes, originalIds }
 */
export async function mergeRecordings(chain, onProgress = () => {}) {
  if (chain.length < 2) throw new Error('mergeRecordings needs >= 2 segments');

  const seed = chain[0];
  const mergedDir = resolve(config.paths.dataDir, 'merged', String(seed.id));
  mkdirSync(mergedDir, { recursive: true });

  // 输出名沿用第一段 basename（去后缀）+ -merged
  const baseName = basename(seed.file_path, extname(seed.file_path));
  const flvOut = resolve(mergedDir, `${baseName}-merged.flv`);
  const xmlOut = resolve(mergedDir, `${baseName}-merged.xml`);

  // 校验源文件全部存在
  for (const r of chain) {
    if (!existsSync(r.file_path)) {
      throw new Error(`merge source missing: ${r.file_path} (id=${r.id})`);
    }
  }

  // 1. 合并 flv（concat -c copy，秒级）
  onProgress('concat', 0);
  await concatLossless({
    inputs: chain.map(r => r.file_path),
    output: flvOut,
    onProgress: ({ percent }) => onProgress('concat', percent || 0),
  });

  // 2. 合并 xml（按各段时长 offset）
  // 优先用 DB 里 duration_sec，没有则 ffprobe 探测
  const durations = [];
  for (const r of chain) {
    if (r.duration_sec && r.duration_sec > 0) {
      durations.push(r.duration_sec);
    } else {
      try { durations.push(await probeDuration(r.file_path)); }
      catch { durations.push(0); }
    }
  }
  const xmlPaths = chain.map(r => guessXmlPath(r.file_path)).filter(p => existsSync(p));
  if (xmlPaths.length === chain.length) {
    try {
      mergeXmls({ xmlPaths, durations, outPath: xmlOut });
    } catch (e) {
      // 弹幕合并失败不阻断录像合并
      console.warn(`[merge] xml merge failed (recordings 仍可上传):`, e.message);
    }
  }

  const st = statSync(flvOut);
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  return {
    flvPath: flvOut,
    xmlPath: existsSync(xmlOut) ? xmlOut : null,
    durationSec: totalDuration,
    sizeBytes: st.size,
    originalIds: chain.map(r => r.id),
  };
}

/** 删合并产物（上传完后调） */
export function cleanupMerged(merged) {
  for (const p of [merged.flvPath, merged.xmlPath]) {
    if (p && existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }
  // 试着删空目录
  try { rmdirSync(dirname(merged.flvPath)); } catch {}
}
