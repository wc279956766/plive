// 上传前转码到 B 站 "1080P 60帧" 档参数。
//
// 目标参数（B 站规格）：
//   分辨率: 1920x1080  帧率: ≥60  编码: H.264 (high profile, level 4.1)
//   视频码率: ≤6000 kbps  音频: AAC 48kHz 2ch ≤320 kbps
//   颜色空间: bt709  位深: 8bit  封装: mp4
//
// 执行路径优先级：
//   1. VAAPI (Intel iGPU) — 走系统 ffmpeg + h264_vaapi，~2.5x 实时
//   2. CPU (libx264)      — 走 ffmpeg-static，~1x 实时
//
// 启动时探测一次：/dev/dri/renderD128 + 系统 ffmpeg + 编码器列表里有 h264_vaapi。
// 关闭硬件编码：设 PLIVE_TRANSCODE_USE_VAAPI=0
//
// 缩放策略：保持源宽高比，黑边补足；不裁剪。
// 速率控制：
//   - VAAPI（UHD 630 LP 模式只支持 CQP）走 -qp 23 ≈ 5Mbps
//   - CPU 走 CRF 18 + maxrate 6000k
import { mkdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { runFfmpeg, probeDuration } from '../ffmpeg.js';

const PRESET = process.env.PLIVE_TRANSCODE_PRESET || 'medium';
const CRF = process.env.PLIVE_TRANSCODE_CRF || '18';
const VAAPI_QP = process.env.PLIVE_TRANSCODE_VAAPI_QP || '23';
const VAAPI_DEVICE = process.env.PLIVE_VAAPI_DEVICE || '/dev/dri/renderD128';
const SYSTEM_FFMPEG = process.env.PLIVE_SYSTEM_FFMPEG || '/usr/bin/ffmpeg';

// 启动时探测 VAAPI 可用性
function detectVaapi() {
  if (process.env.PLIVE_TRANSCODE_USE_VAAPI === '0') return false;
  if (!existsSync(VAAPI_DEVICE)) return false;
  if (!existsSync(SYSTEM_FFMPEG)) return false;
  try {
    const r = spawnSync(SYSTEM_FFMPEG, ['-hide_banner', '-encoders'],
                        { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0) return false;
    return r.stdout.includes('h264_vaapi');
  } catch {
    return false;
  }
}

const USE_VAAPI = detectVaapi();
console.log(`[transcoder] using ${USE_VAAPI ? 'VAAPI (Intel iGPU)' : 'CPU (libx264)'} for 1080p60 transcoding`);

/**
 * VAAPI 路径（Intel UHD 630 LP 模式）。
 *   - CPU 解码 + scale + format=nv12 + hwupload → GPU 编码
 *   - LP 模式只支持 CQP 速率控制（不支持 -b:v / -maxrate VBR）
 */
async function transcodeVaapi({ input, output, totalSec, onProgress }) {
  const args = [
    '-hide_banner', '-y',
    '-init_hw_device', `vaapi=intel:${VAAPI_DEVICE}`,
    '-filter_hw_device', 'intel',
    '-i', input,
    '-vf', 'fps=60,' +
           'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,' +
           'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,' +
           'format=nv12,hwupload',
    '-c:v', 'h264_vaapi',
    '-profile:v', 'high', '-level', '4.1',
    '-low_power', '1', '-rc_mode', 'CQP', '-qp', VAAPI_QP,
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '320k',
    '-movflags', '+faststart',
    output,
  ];
  return await runFfmpeg(args, totalSec, onProgress, SYSTEM_FFMPEG);
}

/** CPU libx264 路径（兼容性 fallback） */
async function transcodeCpu({ input, output, totalSec, onProgress }) {
  const args = [
    '-hide_banner', '-y',
    '-i', input,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-vf', 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,' +
           'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=60',
    '-maxrate', '6000k', '-bufsize', '12000k',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '320k',
    '-movflags', '+faststart',
    output,
  ];
  return await runFfmpeg(args, totalSec, onProgress);
}

/**
 * 转码到 1080p60 H.264 / AAC mp4。
 */
export async function transcodeTo1080p60({ input, output, onProgress = () => {} }) {
  if (!existsSync(input)) throw new Error(`transcode source not found: ${input}`);
  mkdirSync(dirname(output), { recursive: true });

  const totalSec = await probeDuration(input).catch(() => 0);
  const fn = USE_VAAPI ? transcodeVaapi : transcodeCpu;
  const r = await fn({ input, output, totalSec, onProgress });

  if (!r.ok) {
    try { unlinkSync(output); } catch {}
    throw new Error(`transcode (${USE_VAAPI ? 'vaapi' : 'cpu'}) failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  }
  const st = statSync(output);
  return { sizeBytes: st.size, durationSec: totalSec };
}
