// 手动触发上传 / 重试 API
import { db, now } from '../db.js';
import { loadCookies } from '../bilibili/auth.js';
import { uploadFile, submitVideo } from '../bilibili/upload.js';
import { renderTemplateObject, buildContext } from '../bilibili/template.js';
import { startProgress, updateProgress, finishProgress, getProgress, listProgress }
  from '../lib/uploadProgress.js';
import { findMergeCandidates, mergeRecordings, cleanupMerged, DEFAULT_GAP_SEC }
  from '../lib/recordingMerge.js';
import { transcodeTo1080p60 } from '../lib/transcoder.js';
import { resolve, basename, extname } from 'node:path';
import { statSync, unlinkSync } from 'node:fs';
import { config } from '../config.js';

const TRANSCODE_BEFORE_UPLOAD = process.env.PLIVE_TRANSCODE !== '0';

const findRecording = db.prepare(`
  SELECT r.*, rm.id AS r_room_id, rm.name AS r_room_name, rm.upload_template_json
  FROM recordings r JOIN rooms rm ON rm.id = r.room_id WHERE r.id = ?
`);
const setStatus = db.prepare(`UPDATE recordings SET upload_status = ?, upload_log = ?, bilibili_bvid = COALESCE(?, bilibili_bvid) WHERE id = ?`);

// 切片相关：通过 source_recording 关联到房间拿模板
const findSlice = db.prepare(`
  SELECT s.*, r.room_id, rm.name AS r_room_name, rm.upload_template_json
  FROM slices s
  LEFT JOIN recordings r ON r.id = s.source_recording_id
  LEFT JOIN rooms rm ON rm.id = r.room_id
  WHERE s.id = ?
`);
const setSliceStatus = db.prepare(`
  UPDATE slices SET upload_status = ?, upload_log = ?, bilibili_bvid = COALESCE(?, bilibili_bvid) WHERE id = ?
`);

export default async function routes(fastify) {
  /**
   * 渲染录像的默认上传 metadata（拿房间模板 + 替换占位符），用于 UI 弹窗预填。
   */
  fastify.get('/api/recordings/:id/upload-defaults', async (req, reply) => {
    const id = Number(req.params.id);
    const job = findRecording.get(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const tmpl = job.upload_template_json ? JSON.parse(job.upload_template_json) : {};
    const ctx = buildContext({
      room: { id: job.r_room_id, name: job.r_room_name },
      recording: job,
    });
    const rendered = renderTemplateObject(tmpl, ctx);
    return {
      title: rendered.title_template || `${ctx.name} 直播录像 ${ctx.date}`,
      tid: tmpl.tid || 21,
      tag: rendered.tag || `直播录像,${ctx.name}`,
      desc: rendered.desc || `源直播间: live.bilibili.com/${ctx.roomId}`,
      copyright: tmpl.copyright || 2,
      source: rendered.source || `https://live.bilibili.com/${ctx.roomId}`,
    };
  });

  /**
   * 查询某段录像的相邻段（用于上传弹窗里展示"是否合并"）。
   * 返回结果含 seed 自身。
   */
  fastify.get('/api/recordings/:id/merge-candidates', async (req, reply) => {
    const id = Number(req.params.id);
    const seed = findRecording.get(id);
    if (!seed) return reply.code(404).send({ error: 'not found' });
    const gap = Math.max(1, Number(req.query?.gap || DEFAULT_GAP_SEC));
    const chain = findMergeCandidates(id, gap);
    return { gap_sec: gap, candidates: chain };
  });

  /**
   * 触发上传（异步），可选指定 merge_recording_ids 把多段合并后上传。
   * Body: { title, tid, tag, desc, copyright, source, merge_recording_ids?: number[] }
   */
  fastify.post('/api/recordings/:id/upload', async (req, reply) => {
    const id = Number(req.params.id);
    const job = findRecording.get(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (!loadCookies()) return reply.code(401).send({ error: '未登录 B 站' });
    if (job.upload_status === 'uploading') {
      return reply.code(409).send({ error: '该录像正在上传中' });
    }
    const meta = req.body || {};
    if (!meta.title) return reply.code(400).send({ error: 'title 必填' });

    // 计算合并集（含 seed 自身）。前端可通过 merge_recording_ids 指定要合并哪些
    let mergeIds = Array.isArray(meta.merge_recording_ids) ? meta.merge_recording_ids : [id];
    if (!mergeIds.includes(id)) mergeIds = [id, ...mergeIds];
    const mergeRecs = mergeIds
      .map(rid => findRecording.get(rid))
      .filter(Boolean);
    if (mergeRecs.length !== mergeIds.length) {
      return reply.code(400).send({ error: 'merge_recording_ids 中有不存在的 id' });
    }
    // 排序：按 started_at 升序合并
    mergeRecs.sort((a, b) => a.started_at - b.started_at);
    const willMerge = mergeRecs.length > 1;

    // 全部置 uploading
    for (const r of mergeRecs) setStatus.run('uploading', null, null, r.id);

    const key = `rec:${id}`;
    const totalBytes = mergeRecs.reduce((s, r) => {
      try { return s + statSync(r.file_path).size; } catch { return s; }
    }, 0);
    startProgress(key, totalBytes);

    (async () => {
      let merged = null;
      let transcodedPath = null;
      try {
        const t0 = Date.now();
        let uploadPath = job.file_path;
        if (willMerge) {
          updateProgress(key, { phase: 'merging' });
          merged = await mergeRecordings(mergeRecs, (subPhase, percent) => {
            updateProgress(key, { phase: 'merging', percent: Math.min(percent || 0, 99) });
          });
          uploadPath = merged.flvPath;
        }
        if (TRANSCODE_BEFORE_UPLOAD) {
          const tBase = basename(uploadPath, extname(uploadPath));
          transcodedPath = resolve(config.paths.dataDir, 'transcoded', `${tBase}-1080p60.mp4`);
          updateProgress(key, { phase: 'transcoding', percent: 0 });
          await transcodeTo1080p60({
            input: uploadPath, output: transcodedPath,
            onProgress: ({ percent }) => updateProgress(key, {
              phase: 'transcoding', percent: Math.min(percent || 0, 99),
            }),
          });
          uploadPath = transcodedPath;
        }
        const { uposUri } = await uploadFile(uploadPath, p => updateProgress(key, p));
        const { bvid } = await submitVideo({ uposUri, ...meta });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const log = willMerge
          ? `merged ${mergeRecs.map(r => r.id).join(',')} → uploaded in ${elapsed}s, bvid=${bvid}`
          : `uploaded in ${elapsed}s, bvid=${bvid}`;
        for (const r of mergeRecs) setStatus.run('success', log, bvid, r.id);
        finishProgress(key, { ok: true, bvid });
      } catch (e) {
        const msg = String(e.message || e).slice(0, 4000);
        for (const r of mergeRecs) setStatus.run('failed', msg, null, r.id);
        finishProgress(key, { ok: false, error: msg });
      } finally {
        if (merged) cleanupMerged(merged);
        if (transcodedPath) { try { unlinkSync(transcodedPath); } catch {} }
      }
    })();
    return { ok: true, willMerge, mergeIds: mergeRecs.map(r => r.id) };
  });

  // ---- 切片上传 ----
  fastify.get('/api/slices/:id/upload-defaults', async (req, reply) => {
    const id = Number(req.params.id);
    const slice = findSlice.get(id);
    if (!slice) return reply.code(404).send({ error: 'not found' });
    const tmpl = slice.upload_template_json ? JSON.parse(slice.upload_template_json) : {};
    const ctx = buildContext({
      room: { id: slice.room_id, name: slice.r_room_name },
      // 用切片元数据填充：date 用 created_at，title 优先用切片自己的 title
      recording: { started_at: slice.created_at, file_path: slice.file_path },
    });
    const sliceTitle = slice.title || `切片 #${slice.id}`;
    return {
      title: sliceTitle.length > 4 ? sliceTitle : `${ctx.name} 切片 ${ctx.date}`,
      tid: tmpl.tid || 21,
      tag: tmpl.tag ? renderTemplateObject({ x: tmpl.tag }, ctx).x : `直播切片,${ctx.name}`,
      desc: tmpl.desc ? renderTemplateObject({ x: tmpl.desc }, ctx).x : `源直播间: live.bilibili.com/${ctx.roomId}`,
      copyright: tmpl.copyright || 2,
      source: tmpl.source ? renderTemplateObject({ x: tmpl.source }, ctx).x : `https://live.bilibili.com/${ctx.roomId}`,
    };
  });

  fastify.post('/api/slices/:id/upload', async (req, reply) => {
    const id = Number(req.params.id);
    const slice = findSlice.get(id);
    if (!slice) return reply.code(404).send({ error: 'not found' });
    if (!loadCookies()) return reply.code(401).send({ error: '未登录 B 站' });
    if (slice.upload_status === 'uploading')
      return reply.code(409).send({ error: '该切片正在上传中' });
    const meta = req.body || {};
    if (!meta.title) return reply.code(400).send({ error: 'title 必填' });

    setSliceStatus.run('uploading', null, null, id);
    const key = `slice:${id}`;
    const totalBytes = (() => { try { return statSync(slice.file_path).size; } catch { return 0; } })();
    startProgress(key, totalBytes);

    (async () => {
      try {
        const t0 = Date.now();
        const { uposUri } = await uploadFile(slice.file_path, p => updateProgress(key, p));
        const { bvid } = await submitVideo({ uposUri, ...meta });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSliceStatus.run('success', `uploaded in ${elapsed}s, bvid=${bvid}`, bvid, id);
        finishProgress(key, { ok: true, bvid });
      } catch (e) {
        const msg = String(e.message || e).slice(0, 4000);
        setSliceStatus.run('failed', msg, null, id);
        finishProgress(key, { ok: false, error: msg });
      }
    })();
    return { ok: true };
  });

  // ---- 进度查询 ----
  // 一个端点拿全部，前端轮询时简单：
  //   GET /api/uploads/progress       → { 'rec:12': {...}, 'slice:3': {...} }
  fastify.get('/api/uploads/progress', async () => listProgress());

  // 也提供单条查询
  fastify.get('/api/uploads/progress/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params;
    if (!['rec', 'slice'].includes(kind))
      return reply.code(400).send({ error: 'kind must be rec or slice' });
    const p = getProgress(`${kind}:${Number(id)}`);
    if (!p) return reply.code(404).send({ error: 'no progress' });
    return p;
  });
}
