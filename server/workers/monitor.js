import { db, now } from '../db.js';
import { config } from '../config.js';
import { getRoomStatusAndName } from '../bilibili.js';

let timer = null;

const selectRooms = db.prepare(`SELECT id, name, last_status FROM rooms WHERE enabled = 1`);
const updateRoomStatus = db.prepare(`
  UPDATE rooms
  SET last_status = ?, last_status_at = ?, name = COALESCE(?, name), updated_at = ?
  WHERE id = ?
`);

async function checkOne(room) {
  try {
    const s = await getRoomStatusAndName(room.id);
    const status = s.isLive ? 'live' : 'offline';
    const t = now();
    updateRoomStatus.run(status, t, s.name, t, room.id);
    if (status !== room.last_status) {
      console.log(`[monitor] ${room.id} (${s.name || '?'}) ${room.last_status || '?'} -> ${status}: ${s.title || ''}`);
      // TODO: emit event for recorder worker
    }
  } catch (e) {
    console.error(`[monitor] room=${room.id} error:`, e.message);
  }
}

async function tick() {
  const rooms = selectRooms.all();
  await Promise.all(rooms.map(checkOne));
}

export function startMonitor() {
  const interval = (config.monitor?.intervalSec || 30) * 1000;
  console.log(`[monitor] starting, interval=${interval}ms`);
  // initial run + interval
  tick();
  timer = setInterval(tick, interval);
}

export function stopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
