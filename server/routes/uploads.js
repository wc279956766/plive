// 手动触发上传 / 重试 API
import { db, now } from '../db.js';
import { loadCookies } from '../bilibili/auth.js';
import { uploadFile, submitVideo } from '../bilibili/upload.js';
import { renderTemplateObject, buildContext } from '../bilibili/template.js';

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
   * 手动触发上传（同步阻塞，用于小文件 / 调试。生产场景走 worker）。
   * Body: { title, tid, tag, desc, copyright, source }
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

    setStatus.run('uploading', null, null, id);
    // 异步启动上传，立即返回；前端轮询 status
    (async () => {
      try {
        const t0 = Date.now();
        const { uposUri } = await uploadFile(job.file_path);
        const { bvid } = await submitVideo({ uposUri, ...meta });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setStatus.run('success', `uploaded in ${elapsed}s, bvid=${bvid}`, bvid, id);
      } catch (e) {
        setStatus.run('failed', String(e.message || e).slice(0, 4000), null, id);
      }
    })();
    return { ok: true, message: 'started, poll /api/recordings/:id for status' };
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
    (async () => {
      try {
        const t0 = Date.now();
        const { uposUri } = await uploadFile(slice.file_path);
        const { bvid } = await submitVideo({ uposUri, ...meta });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSliceStatus.run('success', `uploaded in ${elapsed}s, bvid=${bvid}`, bvid, id);
      } catch (e) {
        setSliceStatus.run('failed', String(e.message || e).slice(0, 4000), null, id);
      }
    })();
    return { ok: true };
  });
}
