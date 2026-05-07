import { db } from '../db.js';
import { unlinkSync, existsSync } from 'node:fs';

const listAll = db.prepare(`
  SELECT s.*, r.room_id, r.file_path AS src_file_path
  FROM slices s
  LEFT JOIN recordings r ON r.id = s.source_recording_id
  ORDER BY s.created_at DESC
  LIMIT ? OFFSET ?
`);
const findById = db.prepare(`SELECT * FROM slices WHERE id = ?`);
const remove = db.prepare(`DELETE FROM slices WHERE id = ?`);

export default async function routes(fastify) {
  fastify.get('/api/slices', async (req) => {
    const limit  = Math.min(parseInt(req.query.limit ?? '200', 10), 500);
    const offset = parseInt(req.query.offset ?? '0', 10);
    return listAll.all(limit, offset);
  });

  // 切片由 Phase 4 的切片器创建，这里先只支持手动删除（包括磁盘文件）
  fastify.delete('/api/slices/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = findById.get(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const deleteFile = req.query?.delete_file !== '0' && req.query?.delete_file !== 'false';
    if (deleteFile && row.file_path && existsSync(row.file_path)) {
      try { unlinkSync(row.file_path); } catch (e) {
        fastify.log.warn({ err: e }, 'failed to unlink slice file');
      }
    }
    remove.run(id);
    return { ok: true };
  });
}
