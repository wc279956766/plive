// 弹幕处理：切 xml + 转 ass（DanmakuFactory）+ ffmpeg 烧入
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.js';

const DF_BIN = resolve(config.paths.binDir, 'DanmakuFactory');

/**
 * 切片 xml：保留 [startSec, endSec] 内的弹幕，时间戳偏移到 0 起。
 * Bilibili xml 弹幕：<d p="time(s),mode,fontsize,color,sendDate,pool,userHash,rowID">text</d>
 */
export function sliceXml(srcPath, dstPath, startSec, endSec) {
  if (!existsSync(srcPath)) throw new Error(`xml not found: ${srcPath}`);
  const xml = readFileSync(srcPath, 'utf8');
  const re = /<d\s+p="([^"]+)"([^>]*)>([\s\S]*?)<\/d>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const fields = m[1].split(',');
    const t = parseFloat(fields[0]);
    if (!isFinite(t)) continue;
    if (t < startSec || t > endSec) continue;
    fields[0] = (t - startSec).toFixed(3);
    out.push(`<d p="${fields.join(',')}"${m[2]}>${m[3]}</d>`);
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<i>\n  <chatserver>chat.bilibili.com</chatserver>\n  <chatid>0</chatid>\n` +
    out.join('\n') + '\n</i>\n');
  return out.length;
}

/**
 * 用 DanmakuFactory 把 xml 转成 ass。
 */
export function convertXmlToAss(xmlPath, assPath, { width = 1920, height = 1080 } = {}) {
  return new Promise((res, rej) => {
    mkdirSync(dirname(assPath), { recursive: true });
    const args = [
      '-o', 'ass', assPath,
      '-i', 'xml', xmlPath,
      '-r', `${width}x${height}`,
      '-s', '12',                         // 滚动时间
      '-f', '5',                          // 固定弹幕停留时间
      '--fontsize', '38',
      '-O', '180',                        // 不透明度 0-255
      '-L', '1',                          // 描边宽度 0-4
      '-D', '1',                          // 阴影深度 0-4
      '--displayarea', '0.85',
      '--scrollarea', '0.6',
      '-N', 'Microsoft YaHei',
    ];
    const p = spawn(DF_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code === 0 && existsSync(assPath)) res();
      else rej(new Error(err || `DanmakuFactory exit ${code}`));
    });
    p.on('error', e => rej(e));
  });
}

/**
 * 由源视频路径推测 xml 路径（BR 录的话与 .flv 同名）。
 */
export function guessXmlPath(videoPath) {
  return videoPath.replace(/\.[^.]+$/, '.xml');
}

/**
 * 临时切出 + 转换 ass，返回 ass 路径（调用方负责清理 tmp 文件，或交给 OS）。
 */
export async function prepareDanmakuAss({ srcXml, startSec, endSec, opts }) {
  const stamp = Date.now() + '-' + Math.random().toString(16).slice(2);
  const tmpDir = tmpdir();
  const tmpXml = resolve(tmpDir, `dm-${stamp}.xml`);
  const tmpAss = resolve(tmpDir, `dm-${stamp}.ass`);
  const count = sliceXml(srcXml, tmpXml, startSec, endSec);
  if (count === 0) {
    try { unlinkSync(tmpXml); } catch {}
    return { assPath: null, count: 0 };
  }
  await convertXmlToAss(tmpXml, tmpAss, opts);
  try { unlinkSync(tmpXml); } catch {}
  return { assPath: tmpAss, count };
}
