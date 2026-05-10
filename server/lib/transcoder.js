// 上传前转码到 B 站 "1080P 60帧" 档参数。
//
// 参考 B 站清晰度规范：
//   分辨率: 1920x1080  帧率: ≥60  编码: H.264 (high profile, level 4.1)
//   视频码率: ≤6000 kbps  音频: AAC 48kHz 2ch ≤320 kbps
//   颜色空间: bt709-nc  位深: 8bit  封装: mp4/flv
//
// 缩放策略：保持源宽高比，黑边补足；不裁剪。
// 速率控制：CRF 18（视觉接近无损） + maxrate/bufsize 限码（保证不超 6Mbps 平均）。
//
// 注意：CPU 编码慢——4 小时 1080p 在 medium preset 下大概 1x 实时（~4小时编码）。
// 想加速可设 PLIVE_TRANSCODE_PRESET=fast/veryfast，或后续接 QSV/NVENC 硬件编码。
import { mkdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { runFfmpeg, probeDuration } from '../ffmpeg.js';

const PRESET = process.env.PLIVE_TRANSCODE_PRESET || 'medium';
const CRF = process.env.PLIVE_TRANSCODE_CRF || '18';
const MAX_BITRATE = '6000k';
const BUF_SIZE = '12000k';

/**
 * 转码到 1080p60 H.264 / AAC mp4。
 * @param input 源文件（.flv 或 .mp4）
 * @param output 目标 .mp4 路径
 * @param onProgress({ percent, currentSec })
 */
export async function transcodeTo1080p60({ input, output, onProgress = () => {} }) {
  if (!existsSync(input)) throw new Error(`transcode source not found: ${input}`);
  mkdirSync(dirname(output), { recursive: true });

  const totalSec = await probeDuration(input).catch(() => 0);

  const args = [
    '-hide_banner', '-y',
    '-i', input,
    // 视频
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', CRF,
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    // 缩放到 1080p（保持比例 + 黑边补齐）+ 强制 60fps
    '-vf', 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,' +
           'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=60',
    // 限码（CRF 模式下也限制最大瞬时码率）
    '-maxrate', MAX_BITRATE,
    '-bufsize', BUF_SIZE,
    // 音频
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '320k',
    // 容器优化（开头放 moov 方便边下边播）
    '-movflags', '+faststart',
    output,
  ];

  const r = await runFfmpeg(args, totalSec, onProgress);
  if (!r.ok) {
    try { unlinkSync(output); } catch {}
    throw new Error(`transcode failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  }
  const st = statSync(output);
  return { sizeBytes: st.size, durationSec: totalSec };
}
