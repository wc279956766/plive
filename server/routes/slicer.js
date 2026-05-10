// 切片创建 API + 录像文件流（让前端 <video> 能播放源录像）
import { db, now } from '../db.js';
import { config } from '../config.js';
import { sliceLossless, concatLossless, sliceWithDanmakuBurn } from '../ffmpeg.js';
import { prepareDanmakuAss, guessXmlPath } from '../danmaku.js';
import { generateProxy, getProxyState, proxyPathFor } from '../lib/proxy.js';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdirSync, statSync } from 'node:fs';
import { resolve, basename, dirname, extname } from 'node:path';

const findRec = db.prepare(`SELECT * FROM recordings WHERE id = ?`);
const insertSlice = db.prepare(`
  INSERT INTO slices (source_recording_id, file_path, title, start_sec, end_sec,
                      duration_sec, size_bytes, burn_danmaku, upload_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
`);

// 切片产物默认放在 dataDir/slices/<sourceRecId>/<title>.mp4
function sliceOutputPath(rec, title) {
  const safeTitle = (title || `slice-${Date.now()}`).replace(/[\/\\?<>:"|*]/g, '_');
  const recBase = basename(rec.file_path, extname(rec.file_path));
  const dir = resolve(config.paths.dataDir, 'slices', recBase);
  return resolve(dir, `${safeTitle}.mp4`);
}

export default async function routes(fastify) {
  // 让 <video> 能直接播放录像源（HTTP Range 支持，@fastify/static 已自动处理）
  // 通过 path id 查 file_path 然后 send。
  fastify.get('/api/recordings/:id/stream', async (req, reply) => {
    const rec = findRec.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    if (!existsSync(rec.file_path)) return reply.code(410).send({ error: 'file gone' });
    return reply.sendFile(basename(rec.file_path), dirname(rec.file_path));
  });

  // 切片器预览代理（容器 remux 后的 fragmented MP4，浏览器原生播）
  fastify.get('/api/recordings/:id/proxy', async (req, reply) => {
    const rec = findRec.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    const state = getProxyState(rec.id);
    if (state.state === 'ready') {
      return reply.sendFile(basename(state.path), dirname(state.path));
    }
    return reply.code(404).send({ error: 'proxy not ready', state });
  });

  fastify.get('/api/recordings/:id/proxy/status', async (req, reply) => {
    const rec = findRec.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    return getProxyState(rec.id);
  });

  fastify.post('/api/recordings/:id/proxy', async (req, reply) => {
    const rec = findRec.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    if (!existsSync(rec.file_path)) return reply.code(410).send({ error: 'source file gone' });
    try {
      await generateProxy(rec.id, rec.file_path);
      return getProxyState(rec.id);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });


  // 创建一个切片
  fastify.post('/api/slices', async (req, reply) => {
    const { source_recording_id, start_sec, end_sec, title, burn_danmaku } = req.body || {};
    if (!Number.isInteger(source_recording_id))
      return reply.code(400).send({ error: 'source_recording_id required' });
    if (!(start_sec >= 0 && end_sec > start_sec))
      return reply.code(400).send({ error: 'invalid start_sec/end_sec' });
    const rec = findRec.get(source_recording_id);
    if (!rec) return reply.code(404).send({ error: 'recording not found' });
    if (!existsSync(rec.file_path)) return reply.code(410).send({ error: 'source file gone' });

    const output = sliceOutputPath(rec, title);
    let res, assPath = null;
    try {
      if (burn_danmaku) {
        const xmlPath = guessXmlPath(rec.file_path);
        if (!existsSync(xmlPath)) {
          return reply.code(400).send({ error: `源弹幕文件不存在: ${xmlPath}` });
        }
        fastify.log.info(`slicing+burn ${rec.file_path} [${start_sec}..${end_sec}] xml=${xmlPath}`);
        const prep = await prepareDanmakuAss({ srcXml: xmlPath, startSec: start_sec, endSec: end_sec });
        if (prep.count === 0) {
          // 区间内无弹幕，降级到纯切
          fastify.log.warn('该区间无弹幕，降级为纯净切片');
          res = await sliceLossless({ input: rec.file_path, output, startSec: start_sec, endSec: end_sec });
        } else {
          assPath = prep.assPath;
          res = await sliceWithDanmakuBurn({
            input: rec.file_path, output, startSec: start_sec, endSec: end_sec, assPath,
          });
        }
      } else {
        fastify.log.info(`slicing ${rec.file_path} [${start_sec}..${end_sec}] -> ${output}`);
        res = await sliceLossless({ input: rec.file_path, output, startSec: start_sec, endSec: end_sec });
      }
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    } finally {
      if (assPath) try { unlinkSync(assPath); } catch {}
    }
    const r = insertSlice.run(
      source_recording_id, output, title || null,
      start_sec, end_sec, res.durationSec, res.sizeBytes,
      burn_danmaku ? 1 : 0,
      now(),
    );
    return { id: r.lastInsertRowid, file_path: output,
             size_bytes: res.sizeBytes, duration_sec: res.durationSec,
             burn_danmaku: !!burn_danmaku };
  });

  // 多切片合并（"三切一"）
  fastify.post('/api/slices/merge', async (req, reply) => {
    const { slice_ids, title } = req.body || {};
    if (!Array.isArray(slice_ids) || slice_ids.length < 2) {
      return reply.code(400).send({ error: '至少选 2 个切片' });
    }
    if (!title) return reply.code(400).send({ error: 'title 必填' });

    // 拉所有切片，按传入顺序排序
    const findSlice = db.prepare(`SELECT * FROM slices WHERE id = ?`);
    const slices = slice_ids.map(id => findSlice.get(id));
    if (slices.some(s => !s)) return reply.code(404).send({ error: '某个切片不存在' });
    const missing = slices.find(s => !existsSync(s.file_path));
    if (missing) return reply.code(410).send({ error: `切片文件丢失：${missing.file_path}` });

    // 输出位置：data/slices/merged/<title>.mp4
    const safeTitle = title.replace(/[\/\\?<>:"|*]/g, '_');
    const output = resolve(config.paths.dataDir, 'slices', 'merged', `${safeTitle}.mp4`);

    fastify.log.info(`merging ${slices.length} slices → ${output}`);
    let res;
    try {
      res = await concatLossless({ inputs: slices.map(s => s.file_path), output });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
    const totalDuration = slices.reduce((a, s) => a + (s.duration_sec || 0), 0);
    // 沿用第一个切片的 source_recording_id 作为关联（用于上传时取模板）
    const r = insertSlice.run(
      slices[0].source_recording_id, output, title,
      0, totalDuration, totalDuration, res.sizeBytes,
      0, now(),
    );
    return { id: r.lastInsertRowid, file_path: output,
             size_bytes: res.sizeBytes, duration_sec: totalDuration,
             merged_from: slice_ids };
  });
}
