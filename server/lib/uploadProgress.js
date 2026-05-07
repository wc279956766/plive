// 上传进度的内存存储（重启后丢失，符合"重启重传 = 重置进度"的语义）。
//
// key 形如 'rec:12' / 'slice:3'，避免 recordings 和 slices 主键空间撞。
//
// 数据结构：
//   {
//     state:        'running' | 'success' | 'failed',
//     phase:        'preupload' | 'init' | 'uploading' | 'completing',
//     percent:      0..100,
//     uploadedBytes,
//     totalBytes,
//     currentChunk, totalChunks,
//     speedBytesPerSec,    // 最近 ~3s 平均
//     startedAt,           // unix ms
//     updatedAt,           // unix ms
//     finishedAt,          // unix ms (state != running 后)
//     error,               // 失败时的 message
//     bvid,                // 成功时的 BV
//   }

const map = new Map();

// 内部速度计算的环形缓冲：[{t, bytes}, ...]
const speedSamples = new Map();   // key → array
const SPEED_WINDOW_MS = 3000;

function pushSpeedSample(key, bytes) {
  const now = Date.now();
  const arr = speedSamples.get(key) || [];
  arr.push({ t: now, bytes });
  // 只保留最近 SPEED_WINDOW_MS
  while (arr.length > 1 && now - arr[0].t > SPEED_WINDOW_MS) arr.shift();
  speedSamples.set(key, arr);
  if (arr.length < 2) return 0;
  const dt = (arr[arr.length - 1].t - arr[0].t) / 1000;
  const db = arr[arr.length - 1].bytes - arr[0].bytes;
  return dt > 0 ? db / dt : 0;
}

export function startProgress(key, totalBytes) {
  const now = Date.now();
  map.set(key, {
    state: 'running',
    phase: 'preupload',
    percent: 0,
    uploadedBytes: 0,
    totalBytes: totalBytes || 0,
    currentChunk: 0,
    totalChunks: 0,
    speedBytesPerSec: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    bvid: null,
  });
  speedSamples.delete(key);
}

export function updateProgress(key, patch) {
  const cur = map.get(key);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  if (patch.uploadedBytes !== undefined) {
    next.speedBytesPerSec = pushSpeedSample(key, patch.uploadedBytes);
  }
  map.set(key, next);
}

export function finishProgress(key, { ok, error, bvid }) {
  const cur = map.get(key);
  if (!cur) return;
  map.set(key, {
    ...cur,
    state: ok ? 'success' : 'failed',
    percent: ok ? 100 : cur.percent,
    error: error || null,
    bvid: bvid || null,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  });
  speedSamples.delete(key);
}

export function getProgress(key) {
  return map.get(key) || null;
}

/** 列出所有状态（含已完成的，前端展示完最后一帧用） */
export function listProgress() {
  return Object.fromEntries(map);
}

/** 清掉一条（手动重置） */
export function clearProgress(key) {
  map.delete(key);
  speedSamples.delete(key);
}
