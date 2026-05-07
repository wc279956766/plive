import { db } from '../db.js';
import { existsSync } from 'node:fs';

const listRecent = db.prepare(`
  SELECT r.*, rm.name AS room_name
  FROM recordings r
  LEFT JOIN rooms rm ON rm.id = r.room_id
  ORDER BY r.started_at DESC
  LIMIT ? OFFSET ?
`);
function annotate(rows) {
  return rows.map(r => ({ ...r, file_exists: r.file_path ? existsSync(r.file_path) : false }));
}
const findById = db.prepare(`SELECT * FROM recordings WHERE id = ?`);

export default async function routes(fastify) {
  fastify.get('/api/recordings', async (req) => {
    const limit  = Math.min(parseInt(req.query.limit ?? '100', 10), 500);
    const offset = parseInt(req.query.offset ?? '0', 10);
    return annotate(listRecent.all(limit, offset));
  });

  fastify.get('/api/recordings/:id', async (req, reply) => {
    const r = findById.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    return r;
  });
}
