// 上传 worker：周期扫描 recordings 表，把 status='pending' 且房间 auto_upload=1 的拿来处理。
// 每次只跑一个上传任务（避免带宽撞车），失败留日志，不自动重试（手动重试通过 API）。
import { db, now } from '../db.js';
import { uploadFile, submitVideo } from '../bilibili/upload.js';
import { renderTemplateObject, buildContext } from '../bilibili/template.js';
import { loadCookies } from '../bilibili/auth.js';
import { startProgress, updateProgress, finishProgress } from '../lib/uploadProgress.js';
import { findMergeCandidates, mergeRecordings, cleanupMerged,
         DEFAULT_GAP_SEC } from '../lib/recordingMerge.js';

// 下播后等待这么久再上传：避免断流抖动 / 主播短暂下线又上播时把单段提前上传走。
// 期间如果该主播又开播了（房间出现 ended_at IS NULL 的录像），所有该房间 pending 上传一律 defer。
const COOLDOWN_SEC = 600;   // 10 分钟

const findLiveInRoom = db.prepare(`
  SELECT id FROM recordings WHERE room_id = ? AND ended_at IS NULL LIMIT 1
`);
import { statSync } from 'node:fs';

const POLL_INTERVAL_MS = 30_000;

const findPending = db.prepare(`
  SELECT r.*, rm.id AS r_room_id, rm.name AS r_room_name, rm.auto_upload, rm.upload_template_json
  FROM recordings r
  JOIN rooms rm ON rm.id = r.room_id
  WHERE r.upload_status = 'pending'
    AND r.ended_at IS NOT NULL          -- 必须录完
    AND rm.auto_upload = 1
  ORDER BY r.ended_at ASC
  LIMIT 1
`);
const setStatus = db.prepare(`UPDATE recordings SET upload_status = ?, upload_log = ?, bilibili_bvid = COALESCE(?, bilibili_bvid) WHERE id = ?`);

let running = false;
let timer = null;

async function processOne() {
  if (running) return;
  if (!loadCookies()) return;          // 没登录，跳过
  const job = findPending.get();
  if (!job) return;

  // 1. 房间当前是否还在直播（任何 ended_at IS NULL 的录像）→ 无条件 defer
  const liveRec = findLiveInRoom.get(job.room_id);
  if (liveRec) {
    console.log(`[uploader] defer id=${job.id}: 房间 ${job.room_id} 还在直播 (rec id=${liveRec.id})`);
    return;
  }
  // 2. 自动合并相邻段（gap < DEFAULT_GAP_SEC）。chain 已按 started_at 升序。
  const chain = findMergeCandidates(job.id, DEFAULT_GAP_SEC);
  // 3. 冷却期：最晚一段的 ended_at 必须早于 now - COOLDOWN_SEC，否则等
  const lastEnded = Math.max(...chain.map(r => r.ended_at));
  const cooldownLeft = lastEnded + COOLDOWN_SEC - Math.floor(Date.now() / 1000);
  if (cooldownLeft > 0) {
    console.log(`[uploader] defer id=${job.id}: 还需 ${cooldownLeft}s 冷却（避免主播再开播）`);
    return;
  }
  // chain 已按 started_at 升序，第一段作为 seed 用其 file_path/template
  const seed = chain[0];
  const willMerge = chain.length > 1;

  running = true;
  console.log(`[uploader] start id=${seed.id} room=${seed.room_id} file=${seed.file_path}` +
              (willMerge ? ` (merge ${chain.length} 段: ${chain.map(r => r.id).join(',')})` : ''));
  for (const r of chain) setStatus.run('uploading', null, null, r.id);

  const progressKey = `rec:${seed.id}`;
  const totalBytes = chain.reduce((s, r) => {
    try { return s + statSync(r.file_path).size; } catch { return s; }
  }, 0);
  startProgress(progressKey, totalBytes);

  let merged = null;
  try {
    const tmpl = job.upload_template_json ? JSON.parse(job.upload_template_json) : {};
    // 模板上下文用 seed 的元数据（标题/日期取自第一段）
    const ctx = buildContext({
      room: { id: job.r_room_id, name: job.r_room_name },
      recording: seed,
    });
    const rendered = renderTemplateObject(tmpl, ctx);
    const meta = {
      title: rendered.title_template || `${ctx.name} 直播录像 ${ctx.date}`,
      tid: tmpl.tid || 21,
      tag: rendered.tag || `直播录像,${ctx.name}`,
      desc: rendered.desc || `源直播间: live.bilibili.com/${ctx.roomId}`,
      copyright: tmpl.copyright || 2,
      source: rendered.source || `https://live.bilibili.com/${ctx.roomId}`,
      coverUrl: '',
    };
    const t0 = Date.now();
    let uploadPath = seed.file_path;
    if (willMerge) {
      updateProgress(progressKey, { phase: 'merging' });
      merged = await mergeRecordings(chain, (_, percent) => {
        updateProgress(progressKey, { phase: 'merging', percent: Math.min(percent || 0, 99) });
      });
      uploadPath = merged.flvPath;
      console.log(`[uploader] merged ${chain.length} segments → ${uploadPath} (${(merged.sizeBytes/1024/1024).toFixed(1)} MB)`);
    }
    const { uposUri } = await uploadFile(uploadPath, p => {
      updateProgress(progressKey, p);
      if (p.percent !== undefined && Math.floor(p.percent) % 10 === 0)
        console.log(`[uploader] id=${seed.id} ${p.percent.toFixed(1)}%`);
    });
    const { bvid } = await submitVideo({ uposUri, ...meta });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const log = willMerge
      ? `merged ${chain.map(r => r.id).join(',')} → uploaded in ${elapsed}s, bvid=${bvid}`
      : `uploaded in ${elapsed}s, bvid=${bvid}`;
    for (const r of chain) setStatus.run('success', log, bvid, r.id);
    finishProgress(progressKey, { ok: true, bvid });
    console.log(`[uploader] done seed=${seed.id} bvid=${bvid}`);
  } catch (e) {
    console.error(`[uploader] failed seed=${seed.id}:`, e.message);
    const msg = String(e.message || e).slice(0, 4000);
    for (const r of chain) setStatus.run('failed', msg, null, r.id);
    finishProgress(progressKey, { ok: false, error: msg });
  } finally {
    if (merged) cleanupMerged(merged);
    running = false;
  }
}

export function startUploader() {
  console.log('[uploader] worker starting');
  processOne();
  timer = setInterval(processOne, POLL_INTERVAL_MS);
}

export function stopUploader() {
  if (timer) clearInterval(timer);
  timer = null;
}
