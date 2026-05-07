// 上传 worker：周期扫描 recordings 表，把 status='pending' 且房间 auto_upload=1 的拿来处理。
// 每次只跑一个上传任务（避免带宽撞车），失败留日志，不自动重试（手动重试通过 API）。
import { db, now } from '../db.js';
import { uploadFile, submitVideo } from '../bilibili/upload.js';
import { renderTemplateObject, buildContext } from '../bilibili/template.js';
import { loadCookies } from '../bilibili/auth.js';

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
  running = true;
  console.log(`[uploader] start id=${job.id} room=${job.room_id} file=${job.file_path}`);
  setStatus.run('uploading', null, null, job.id);
  try {
    const tmpl = job.upload_template_json ? JSON.parse(job.upload_template_json) : {};
    const ctx = buildContext({
      room: { id: job.r_room_id, name: job.r_room_name },
      recording: job,
    });
    const rendered = renderTemplateObject(tmpl, ctx);
    const meta = {
      title: rendered.title_template || `${ctx.name} 直播录像 ${ctx.date}`,
      tid: tmpl.tid || 21,                              // 默认日常分区
      tag: rendered.tag || `直播录像,${ctx.name}`,
      desc: rendered.desc || `源直播间: live.bilibili.com/${ctx.roomId}`,
      copyright: tmpl.copyright || 2,                   // 默认转载
      source: rendered.source || `https://live.bilibili.com/${ctx.roomId}`,
      coverUrl: '',                                      // Phase 3c 会处理
    };
    const t0 = Date.now();
    const { uposUri } = await uploadFile(job.file_path, ({ percent }) => {
      // 节流写库会很吵，简单 console
      if (Math.floor(percent) % 10 === 0) console.log(`[uploader] id=${job.id} ${percent.toFixed(1)}%`);
    });
    const { bvid } = await submitVideo({ uposUri, ...meta });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setStatus.run('success', `uploaded in ${elapsed}s, bvid=${bvid}`, bvid, job.id);
    console.log(`[uploader] done id=${job.id} bvid=${bvid}`);
  } catch (e) {
    console.error(`[uploader] failed id=${job.id}:`, e.message);
    setStatus.run('failed', String(e.message || e).slice(0, 4000), null, job.id);
  } finally {
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
