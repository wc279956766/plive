// Bilibili 直播 API helpers (no auth, public endpoints).

const UA = 'Mozilla/5.0 (X11; Linux x86_64) plive/0.0.1';

async function jsonGet(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`bilibili api code=${j.code} msg=${j.message || j.msg}`);
  return j.data;
}

/**
 * Get live room info. Returns:
 *   { live_status: 0|1|2, title, parent_area_name, area_name, ... }
 * live_status: 0=未开播, 1=直播中, 2=轮播中
 */
export async function getRoomInfo(roomId) {
  const d = await jsonGet(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
  return d;
}

/**
 * Get the streamer's name + uid for a room.
 */
export async function getRoomUserInfo(roomId) {
  const d = await jsonGet(`https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`);
  // d.info: { uname, uid, ... }
  return d.info;
}

/**
 * One-shot composite: status + name.
 */
export async function getRoomStatusAndName(roomId) {
  const [info, user] = await Promise.all([
    getRoomInfo(roomId),
    getRoomUserInfo(roomId).catch(() => null),
  ]);
  return {
    isLive: info.live_status === 1,
    title: info.title,
    name: user?.uname || null,
    raw: info,
  };
}
