// 切片器预览代理：把 FLV 容器 remux 成 fragmented MP4，画质完全保留。
// 浏览器原生 <video> 播 mp4，不走 MSE，避免 flv.js 大文件 OOM 问题。
//
// 速度：stream-copy 不重编码，11GB 文件 ~50s（disk-bound，约 400x 实时）。
// 大小：跟源 FLV 几乎一样（多 ~0.2% 容器开销）。
import { mkdirSync, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runFfmpeg, probeDuration } from '../ffmpeg.js';
import { config } from '../config.js';

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

  // 异步跑
  (async () => {
    try {
      const r = await runFfmpeg([
        '-hide_banner', '-y',
        '-i', sourcePath,
        '-c', 'copy',
        // fragmented MP4：moov 在前 + 分片帧，浏览器原生支持流式播放和 Range seek
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        // 必须显式 -f mp4：tmp 文件名后缀是 .mp4.tmp，ffmpeg 猜不出 muxer
        '-f', 'mp4',
        tmp,
      ], totalSec, ({ percent }) => { job.percent = percent || 0; });
      if (!r.ok) {
        try { unlinkSync(tmp); } catch {}
        throw new Error(`proxy remux failed: ${r.log.split('\n').slice(-2).join(' | ')}`);
      }
      renameSync(tmp, out);
      job.percent = 100;
      console.log(`[proxy] rec=${id} 完成: ${(statSync(out).size/1024/1024).toFixed(1)} MB`);
    } catch (e) {
      console.error(`[proxy] rec=${id} 失败:`, e.message);
      try { unlinkSync(tmp); } catch {}
    } finally {
      // 留 5s 让前端最后一次轮询拿到 100% 后再清掉
      setTimeout(() => active.delete(id), 5000);
    }
  })();

  return job;
}

export function cleanupProxy(recId) {
  const path = proxyPathFor(recId);
  try { unlinkSync(path); } catch {}
}
