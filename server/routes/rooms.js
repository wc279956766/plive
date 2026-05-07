import { db, now } from '../db.js';
import { addRoomInBR, removeRoomInBR, setAutoRecordInBR } from '../recorder.js';

const list = db.prepare(`SELECT * FROM rooms ORDER BY id`);
const findById = db.prepare(`SELECT * FROM rooms WHERE id = ?`);
const insert = db.prepare(`
  INSERT INTO rooms (id, name, enabled, auto_upload, upload_template_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const update = db.prepare(`
  UPDATE rooms
  SET name = COALESCE(?, name),
      enabled = COALESCE(?, enabled),
      auto_upload = COALESCE(?, auto_upload),
      upload_template_json = COALESCE(?, upload_template_json),
      updated_at = ?
  WHERE id = ?
`);
const remove = db.prepare(`DELETE FROM rooms WHERE id = ?`);

export default async function routes(fastify) {
  fastify.get('/api/rooms', async () => list.all());

  fastify.post('/api/rooms', async (req, reply) => {
    const { id, name = null, enabled = 1, auto_upload = 1, upload_template = null } = req.body || {};
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id (integer) required' });
    const t = now();
    try {
      insert.run(id, name, enabled ? 1 : 0, auto_upload ? 1 : 0,
                 upload_template ? JSON.stringify(upload_template) : null, t, t);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return reply.code(409).send({ error: 'room already exists' });
      }
      throw e;
    }
    if (enabled) addRoomInBR(id, true).catch(e => fastify.log.error(e));
    return findById.get(id);
  });

  fastify.patch('/api/rooms/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { name, enabled, auto_upload, upload_template } = req.body || {};
    update.run(
      name ?? null,
      enabled === undefined ? null : (enabled ? 1 : 0),
      auto_upload === undefined ? null : (auto_upload ? 1 : 0),
      upload_template === undefined ? null : JSON.stringify(upload_template),
      now(),
      id,
    );
    const r = findById.get(id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    // enabled 切换 → BR 增/删；其他字段（name/template/auto_upload）只动 DB 不动 BR
    if (enabled !== undefined) {
      if (enabled) addRoomInBR(id, true).catch(e => fastify.log.error(e));
      else removeRoomInBR(id).catch(e => fastify.log.error(e));
    }
    return r;
  });

  fastify.delete('/api/rooms/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const r = remove.run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    removeRoomInBR(id).catch(e => fastify.log.error(e));
    return { ok: true };
  });
}
