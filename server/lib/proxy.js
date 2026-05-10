// 切片器预览代理：为每段录像生成一个 480p 低码率 mp4，缓存在 data/proxy/<recId>.mp4。
// 浏览器原生播 mp4 不再走 flv.js，避免大文件 OOM。
//
// 切片仍以源 .flv 为准（routes/slicer.js 的 createSlice 用 source_recording_id 找
// recordings.file_path，不依赖代理）。代理只用于 UI 浏览。
import { mkdirSync, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { runFfmpeg, probeDuration } from '../ffmpeg.js';
import { config } from '../config.js';

const VAAPI_DEVICE = process.env.PLIVE_VAAPI_DEVICE || '/dev/dri/renderD128';
const SYSTEM_FFMPEG = process.env.PLIVE_SYSTEM_FFMPEG || '/usr/bin/ffmpeg';

function detectVaapi() {
  if (!existsSync(VAAPI_DEVICE) || !existsSync(SYSTEM_FFMPEG)) return false;
  try {
    const r = spawnSync(SYSTEM_FFMPEG, ['-hide_banner', '-encoders'],
                        { encoding: 'utf-8', timeout: 5000 });
    return r.status === 0 && r.stdout.includes('h264_vaapi');
  } catch { return false; }
}
const USE_VAAPI = detectVaapi();

// 内存里跟踪进行中的代理生成任务： recId → { percent, startedAt }
const active = new Map();

export function proxyPathFor(recId) {
  return resolve(config.paths.dataDir, 'proxy', `${recId}.mp4`);
}

export function getProxyState(recId) {
  const path = proxyPathFor(recId);
  if (existsSync(path)) {
    const st = statSync(path);
    if (st.size > 0) return { state: 'ready', size: st.size, path };
  }
  const cur = active.get(Number(recId));
  if (cur) return { state: 'generating', percent: cur.percent, startedAt: cur.startedAt };
  return { state: 'missing' };
}

export async function generateProxy(recId, sourcePath) {
  const id = Number(recId);
  if (active.has(id)) return active.get(id);     // 已在跑，幂等
  const out = proxyPathFor(id);
  const tmp = out + '.tmp';
  if (existsSync(out) && statSync(out).size > 0) return null;     // 已就绪
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);

  mkdirSync(dirname(out), { recursive: true });
  const totalSec = await probeDuration(sourcePath).catch(() => 0);
  const job = { percent: 0, startedAt: Date.now() };
  active.set(id, job);

  // 异步跑，不阻塞调用方
  (async () => {
    try {
      let r;
      if (USE_VAAPI) {
        // VAAPI 路径：480p, CQP 28（很低）；UHD 630 大约 5-10x 实时
        r = await runFfmpeg([
          '-hide_banner', '-y',
          '-init_hw_device', `vaapi=intel:${VAAPI_DEVICE}`,
          '-filter_hw_device', 'intel',
          '-i', sourcePath,
          '-vf', 'scale=854:480:flags=fast_bilinear:force_original_aspect_ratio=decrease,' +
                 'pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black,' +
                 'format=nv12,hwupload',
          '-c:v', 'h264_vaapi', '-profile:v', 'main',
          '-low_power', '1', '-rc_mode', 'CQP', '-qp', '28',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '96k',
          '-movflags', '+faststart',
          tmp,
        ], totalSec, ({ percent }) => { job.percent = percent || 0; }, SYSTEM_FFMPEG);
      } else {
        // CPU fallback：libx264 veryfast 450p ~500kbps
        r = await runFfmpeg([
          '-hide_banner', '-y',
          '-i', sourcePath,
          '-vf', 'scale=854:480:flags=fast_bilinear:force_original_aspect_ratio=decrease,' +
                 'pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '96k',
          '-movflags', '+faststart',
          tmp,
        ], totalSec, ({ percent }) => { job.percent = percent || 0; });
      }
      if (!r.ok) {
        try { unlinkSync(tmp); } catch {}
        throw new Error(`proxy ffmpeg failed: ${r.log.split('\n').slice(-2).join(' | ')}`);
      }
      renameSync(tmp, out);
      job.percent = 100;
      console.log(`[proxy] rec=${id} 生成完成: ${(statSync(out).size/1024/1024).toFixed(1)} MB`);
    } catch (e) {
      console.error(`[proxy] rec=${id} 失败:`, e.message);
      try { unlinkSync(tmp); } catch {}
    } finally {
      // 留 5 秒让前端最后一次轮询拿到 100% 后再清掉
      setTimeout(() => active.delete(id), 5000);
    }
  })();

  return job;
}

export function cleanupProxy(recId) {
  const path = proxyPathFor(recId);
  try { unlinkSync(path); } catch {}
}
