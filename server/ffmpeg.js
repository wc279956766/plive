// 切片：用 ffmpeg lossless（关键帧对齐 -c copy）剪一段。
// 移植自 EasyCut 的 main.js，逻辑保持等价。
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = ffmpegStaticPath;
export const FFPROBE = ffprobeStatic.path;

/** 用 ffprobe 拿视频时长（秒） */
export function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration',
                  '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const p = spawn(FFPROBE, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'ffprobe failed'));
      const v = parseFloat(out.trim());
      if (!isFinite(v)) return reject(new Error('cannot parse duration'));
      resolve(v);
    });
  });
}

/**
 * 跑 ffmpeg，捕获 stderr 解析进度。
 * @param totalSec 用于计算 percent
 * @param onProgress({ percent, currentSec })
 */
export function runFfmpeg(args, totalSec = 0, onProgress = () => {}) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let log = '';
    p.stderr.on('data', d => {
      const s = d.toString();
      log += s;
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && totalSec > 0) {
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
        onProgress({ percent: Math.min(100, (t / totalSec) * 100), currentSec: t });
      }
    });
    p.on('close', code => resolve({ ok: code === 0, code, log }));
    p.on('error', e => resolve({ ok: false, code: -1, log: String(e) }));
  });
}

/**
 * 无损切一段（-c copy，关键帧对齐，速度极快但首帧可能略偏）。
 * @param input  源 .flv/.mp4
 * @param output 目标 .mp4
 * @param startSec 起点秒
 * @param endSec 终点秒
 */
export async function sliceLossless({ input, output, startSec, endSec, onProgress }) {
  mkdirSync(dirname(output), { recursive: true });
  const args = [
    '-hide_banner', '-y',
    '-ss', String(startSec),
    '-to', String(endSec),
    '-i', input,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    output,
  ];
  const dur = endSec - startSec;
  const r = await runFfmpeg(args, dur, onProgress);
  if (!r.ok) throw new Error(`ffmpeg failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  const st = statSync(output);
  return { sizeBytes: st.size, durationSec: dur };
}

/**
 * 无损拼接多个文件。各文件需要使用相同的编码参数（B 站 BR 录的 flv / 我们切的 mp4 一般兼容）。
 * 用 ffmpeg concat demuxer：写一个 list.txt → -f concat -safe 0 -c copy。
 */
export async function concatLossless({ inputs, output, onProgress }) {
  if (!inputs?.length) throw new Error('no inputs');
  mkdirSync(dirname(output), { recursive: true });
  // 写临时清单
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const listPath = resolve(tmpdir(), `concat-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  // ffmpeg concat 列表语法：每行 file 'PATH'，单引号转义为 '\''
  const lines = inputs.map(p => `file '${p.replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, lines.join('\n'));

  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output];
  // total time 估算：源文件时长之和（用 statSync 拿不到时长，先用 inputs.length 当 progress 单位的近似）
  const r = await runFfmpeg(args, 0, onProgress);
  try { unlinkSync(listPath); } catch {}
  if (!r.ok) throw new Error(`concat failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  const st = statSync(output);
  return { sizeBytes: st.size };
}

/**
 * 切一段并烧入弹幕（必须重新编码，速度慢）。
 * @param assPath 已切片好的 .ass 字幕（时间从 0 起）
 */
export async function sliceWithDanmakuBurn({ input, output, startSec, endSec, assPath, onProgress }) {
  mkdirSync(dirname(output), { recursive: true });
  // ass filter 文件路径需要做转义（: , [] 等都是分隔符）
  const escAss = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const args = [
    '-hide_banner', '-y',
    '-ss', String(startSec),       // 输入快速 seek
    '-i', input,
    '-t', String(endSec - startSec),
    '-vf', `ass='${escAss}'`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
  const dur = endSec - startSec;
  const r = await runFfmpeg(args, dur, onProgress);
  if (!r.ok) throw new Error(`burn failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  const st = statSync(output);
  return { sizeBytes: st.size, durationSec: dur };
}

/**
 * 精确切（重新编码，慢但帧级精确）。MVP 暂不暴露。
 */
export async function sliceSmart({ input, output, startSec, endSec, onProgress }) {
  mkdirSync(dirname(output), { recursive: true });
  const args = [
    '-hide_banner', '-y',
    '-i', input,
    '-ss', String(startSec),
    '-to', String(endSec),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
  const dur = endSec - startSec;
  const r = await runFfmpeg(args, dur, onProgress);
  if (!r.ok) throw new Error(`ffmpeg smart failed: ${r.log.split('\n').slice(-3).join(' | ')}`);
  const st = statSync(output);
  return { sizeBytes: st.size, durationSec: dur };
}
