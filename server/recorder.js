// Manage a single BililiveRecorder.Cli child process.
// Generates its config.json from our DB; restarts on room changes.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { config } from './config.js';
import { db } from './db.js';
import { loadCookies, cookiesToHeader } from './bilibili/auth.js';

// BR 出于安全只允许把录像写在它自己的 workdir 内。
// 所以直接把 BR workdir 设为我们想要的 recordings 目录——BR 的 config.json/logs 也会落在这里。
const recorderWorkdir = config.paths.recordingsDir;
const configPath = resolve(recorderWorkdir, 'config.json');
const cliPath = resolve(config.paths.binDir, 'BililiveRecorder', 'BililiveRecorder.Cli');

// 内部 Cli 自己的 HTTP 端口（不暴露到外部，仅自用），避免和我们后端 :9090 冲突
const CLI_HTTP_BIND = 'http://127.0.0.1:9091';
const CLI_HTTP_PORT = 9091;
// Webhook 回调到我们后端
const WEBHOOK_URL = `http://127.0.0.1:${config.server.port}/api/recorder/webhook`;

let proc = null;
let restartTimer = null;
let stopping = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = createConnection({ port, host });
    let resolved = false;
    const finish = v => { if (!resolved) { resolved = true; resolve(v); sock.destroy(); } };
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.setTimeout(500, () => finish(false));
  });
}

async function waitPortFree(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await sleep(500);
  }
  return false;
}

// BR config 字段都是 Optional<T>，必须包成 { HasValue, Value } 形式
const opt = (v) => ({ HasValue: true, Value: v });

function buildConfigJson() {
  const rooms = db.prepare(`SELECT id FROM rooms WHERE enabled = 1`).all();
  const cookies = loadCookies();
  const cookieStr = cookies ? cookiesToHeader(cookies) : null;

  // 画质优先级（从高到低，BR 会取第一个可用的）：
  //   30000 杜比视界
  //   20000 4K
  //   10000 原画 (1080p+)
  //     401 蓝光(高码率)
  //     400 蓝光
  //     250 超清(720p)
  //     150 高清
  //      80 流畅
  // 没登录时只能拿 250 及以下；登录后才能 10000/20000/30000
  const qualityPriority = [30000, 20000, 10000, 401, 400, 250, 150, 80];

  const global = {
    WorkDirectory: opt(config.paths.recordingsDir),
    // 相对路径，会拼在 cmdline workdir = recordings 目录之下
    FileNameRecordTemplate: opt(
      '{{ roomId }}/{{ "now" | format_date: "yyyyMMdd-HHmmss" }}-{{ name }}-{{ title }}.flv'),
    WebHookUrlsV2: opt(WEBHOOK_URL),
    // 弹幕独立 .xml；上传/切片再决定是否烧进画面
    RecordDanmaku: opt(true),
    RecordDanmakuRaw: opt(false),
    RecordDanmakuSuperChat: opt(true),
    RecordDanmakuGift: opt(false),
    RecordDanmakuGuard: opt(true),
    // 优先尝试最高画质，逐级降级
    RecordingQuality: opt(qualityPriority.join(',')),
  };
  // 登录后注入 cookie，BR 会在拿流时带上去解锁高画质
  if (cookieStr) {
    global.Cookie = opt(cookieStr);
  }

  return {
    $schema: 'https://raw.githubusercontent.com/BililiveRecorder/BililiveRecorder/master/configV3.schema.json',
    version: 3,
    global,
    rooms: rooms.map(r => ({
      RoomId: opt(r.id),
      AutoRecord: opt(true),
    })),
  };
}

function writeRecorderConfig() {
  mkdirSync(recorderWorkdir, { recursive: true });
  mkdirSync(config.paths.recordingsDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(buildConfigJson(), null, 2));
  console.log(`[recorder] wrote config with ${buildConfigJson().rooms.length} room(s)`);
}

async function spawnCli() {
  if (proc) {
    console.warn('[recorder] spawn called but proc already running, skip');
    return;
  }
  if (!existsSync(cliPath)) {
    console.error(`[recorder] CLI not installed at ${cliPath} - run: npm run setup`);
    return;
  }
  // 防止 9091 被孤儿 BR 占着进入 spawn 循环：先等端口释放
  if (await isPortInUse(CLI_HTTP_PORT)) {
    console.warn(`[recorder] :${CLI_HTTP_PORT} 占用中，等待最多 30s 释放...`);
    const free = await waitPortFree(CLI_HTTP_PORT, 30_000);
    if (!free) {
      console.error(`[recorder] :${CLI_HTTP_PORT} 持续被占用，疑似有孤儿 BR 进程。手动 kill 占用方后再 reloadRecorder()，跳过此次 spawn。`);
      return;
    }
  }

  console.log(`[recorder] spawning ${cliPath} run ${recorderWorkdir}`);
  proc = spawn(cliPath, [
    'run',
    recorderWorkdir,
    '--http-bind', CLI_HTTP_BIND,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const myProc = proc;

  proc.stdout.on('data', d => process.stdout.write(`[BR] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[BR] ${d}`));
  proc.on('exit', (code, sig) => {
    console.log(`[recorder] BR exited code=${code} sig=${sig}`);
    if (proc === myProc) proc = null;        // 仅当我们持有的就是这个 proc 时才置空
    if (!stopping) {
      console.log('[recorder] auto-restart in 5s');
      setTimeout(() => { spawnCli().catch(e => console.error('[recorder] respawn err:', e)); }, 5000);
    }
  });
}

export function startRecorder() {
  writeRecorderConfig();
  spawnCli().catch(e => console.error('[recorder] startRecorder spawn err:', e));
}

export async function stopRecorder() {
  stopping = true;
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise(r => proc?.once('exit', r) ?? r());
  }
}

// =====================================================================
// 房间增删改：直接调 BR HTTP API，避免重启 BR 进程切断正在录制的房间。
//
// 重要：以前用 reloadRecorder() = 重写 config.json + SIGTERM BR 的方式，
// BR shutdown 期间会把它内存里的 config 写回 config.json，覆盖我们刚写的新
// 版本，导致新增/启用的房间永远进不了 BR。
// =====================================================================

const BR_API = `http://127.0.0.1:${CLI_HTTP_PORT}`;

async function brFetch(path, opts = {}) {
  try {
    const r = await fetch(`${BR_API}${path}`, opts);
    return r;
  } catch (e) {
    console.error(`[recorder] BR API ${path} fetch error:`, e.message);
    throw e;
  }
}

/** 在 BR 中添加房间（开自动录制）。已存在则忽略。 */
export async function addRoomInBR(roomId, autoRecord = true) {
  const r = await brFetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, autoRecord }),
  });
  if (r.ok) {
    console.log(`[recorder] BR addRoom ${roomId} ok`);
    return true;
  }
  // 409/400 等：已存在，改去设 autoRecord 即可
  if (r.status === 409 || r.status === 400) {
    return setAutoRecordInBR(roomId, autoRecord);
  }
  console.error(`[recorder] BR addRoom ${roomId} failed: HTTP ${r.status}`);
  return false;
}

/** 在 BR 中删除房间。 */
export async function removeRoomInBR(roomId) {
  const r = await brFetch(`/api/room/${roomId}`, { method: 'DELETE' });
  if (r.ok || r.status === 404) {
    console.log(`[recorder] BR removeRoom ${roomId} ok (status=${r.status})`);
    return true;
  }
  console.error(`[recorder] BR removeRoom ${roomId} failed: HTTP ${r.status}`);
  return false;
}

/** 修改 BR 中房间的 autoRecord 设置。 */
export async function setAutoRecordInBR(roomId, autoRecord) {
  const r = await brFetch(`/api/room/${roomId}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoRecord: { hasValue: true, value: autoRecord } }),
  });
  if (r.ok) {
    console.log(`[recorder] BR setAutoRecord ${roomId}=${autoRecord} ok`);
    return true;
  }
  console.error(`[recorder] BR setAutoRecord ${roomId} failed: HTTP ${r.status}`);
  return false;
}

/** 启动后调一次：把 DB 里 enabled 房间和 BR 里的房间对齐。 */
export async function syncRoomsToBR() {
  try {
    const r = await brFetch('/api/room');
    if (!r.ok) {
      console.warn(`[recorder] syncRoomsToBR: BR API GET /api/room HTTP ${r.status}, skip`);
      return;
    }
    const brRooms = await r.json();
    const brIds = new Set(brRooms.map(x => x.roomId));
    const dbRooms = db.prepare(`SELECT id, enabled FROM rooms`).all();
    const dbEnabled = new Set(dbRooms.filter(x => x.enabled).map(x => x.id));

    // 该启用的：DB enabled 但 BR 没有 → addRoom
    for (const id of dbEnabled) {
      if (!brIds.has(id)) await addRoomInBR(id, true);
    }
    // 该删除的：BR 有但 DB 不在 enabled 里 → removeRoom
    for (const id of brIds) {
      if (!dbEnabled.has(id)) await removeRoomInBR(id);
    }
    console.log(`[recorder] syncRoomsToBR done: db.enabled=${dbEnabled.size} br=${brIds.size}`);
  } catch (e) {
    console.error('[recorder] syncRoomsToBR error:', e.message);
  }
}

/**
 * 兼容旧调用：cookie/global 变化时仍然需要重启 BR 才能生效。
 * 也可用于全量重新同步。日常房间增删改请直接用 addRoomInBR/removeRoomInBR/setAutoRecordInBR。
 */
export function reloadRecorder() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    writeRecorderConfig();
    if (proc) {
      console.log('[recorder] restarting BR to apply global config change');
      const old = proc;
      stopping = true;
      old.kill('SIGTERM');
      await new Promise(r => old.once('exit', r));
      proc = null;
      stopping = false;
    }
    await spawnCli();
  }, 1500);
}
