// Webhook endpoint that BililiveRecorder.Cli will call on FileOpening/FileClosed events.
// BR webhook v2 EventData 字段（关键）：
//   RelativePath       — 相对 workdir 的路径（workdir 是 config.paths.recordingsDir）
//   FileOpenTime       — ISO 8601
//   FileCloseTime      — ISO 8601
//   FileSize           — bytes
//   Duration           — seconds (may have ms decimals)
//   RoomId, ShortId, Name, Title, AreaNameParent, AreaNameChild
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { db, now } from '../db.js';
import { config } from '../config.js';

const findRecording = db.prepare(`SELECT * FROM recordings WHERE file_path = ?`);
const insertRec = db.prepare(`
  INSERT INTO recordings (room_id, file_path, started_at, ended_at, size_bytes, duration_sec, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateRec = db.prepare(`
  UPDATE recordings SET ended_at = ?, size_bytes = ?, duration_sec = ? WHERE file_path = ?
`);

function absPath(rel) {
  if (!rel) return null;
  return resolve(config.paths.recordingsDir, rel);
}
function tsFromIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isFinite(t) ? Math.floor(t / 1000) : null;
}

export default async function routes(fastify) {
  fastify.post('/api/recorder/webhook', async (req, reply) => {
    const ev = req.body || {};
    const t = ev.EventType;
    const d = ev.EventData || {};
    fastify.log.info({ EventType: t, RoomId: d.RoomId, RelativePath: d.RelativePath }, 'recorder webhook');

    try {
      if (t === 'FileOpening') {
        const filePath = absPath(d.RelativePath);
        if (filePath) {
          const existing = findRecording.get(filePath);
          if (!existing) {
            const startedAt = tsFromIso(d.FileOpenTime) || Math.floor(Date.now() / 1000);
            insertRec.run(d.RoomId, filePath, startedAt, null, null, null, now());
          }
        }
      } else if (t === 'FileClosed') {
        const filePath = absPath(d.RelativePath);
        if (filePath) {
          let size = typeof d.FileSize === 'number' ? d.FileSize : null;
          if (size === null) { try { size = statSync(filePath).size; } catch {} }
          const dur = typeof d.Duration === 'number' ? Math.floor(d.Duration) : null;
          const endedAt = tsFromIso(d.FileCloseTime) || Math.floor(Date.now() / 1000);
          updateRec.run(endedAt, size, dur, filePath);
        }
      }
      // SessionStarted / SessionEnded / StreamStarted 等不需要落库
    } catch (e) {
      fastify.log.error({ err: e }, 'webhook handler error');
    }
    return { ok: true };
  });
}
