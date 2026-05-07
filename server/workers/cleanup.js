// 本地保留 7 天 cleanup worker：
// 只清理「上传成功」且超过 retention.recordingDays 天的录像（.flv + .xml）。
// 失败 / 等待中的录像不动，让你有机会重试或手动处理。
// 切片永不自动清理。
import { db, now } from '../db.js';
import { config } from '../config.js';
import { unlinkSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const CHECK_INTERVAL_MS = 6 * 3600 * 1000;   // 6 小时跑一次
let timer = null;

const findOld = db.prepare(`
  SELECT id, file_path, ended_at, bilibili_bvid
  FROM recordings
  WHERE upload_status = 'success'
    AND ended_at IS NOT NULL
    AND ended_at < ?
`);

function tick() {
  const days = config.retention?.recordingDays ?? 7;
  const cutoff = now() - days * 86400;
  const olds = findOld.all(cutoff);
  let removed = 0;
  for (const r of olds) {
    const xml = r.file_path.replace(new RegExp(extname(r.file_path) + '$'), '.xml');
    for (const p of [r.file_path, xml]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          removed++;
          console.log(`[cleanup] removed ${p} (rec #${r.id} bvid=${r.bilibili_bvid || '?'})`);
        } catch (e) {
          console.error(`[cleanup] unlink ${p}: ${e.message}`);
        }
      }
    }
  }
  if (removed > 0) console.log(`[cleanup] tick done, removed ${removed} files`);
}

export function startCleanup() {
  console.log(`[cleanup] starting, retention=${config.retention?.recordingDays ?? 7}d, interval=${CHECK_INTERVAL_MS/3600000}h`);
  // 启动 5 分钟后跑第一次（避开启动峰值）
  setTimeout(tick, 5 * 60 * 1000);
  timer = setInterval(tick, CHECK_INTERVAL_MS);
}

export function stopCleanup() {
  if (timer) clearInterval(timer);
  timer = null;
}
