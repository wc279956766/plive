// B 站 UPOS 上传协议的最小实现。
// 流程：preupload → init → 分片 PUT → complete → submit
//
// 参考社区已知协议（biliup-rs / biliup / bilibili-API-collect）。
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { biliFetch, biliJson, getCsrf } from './client.js';

// ugcupos/bup = 正常多段直传（bucket ugcever）。
// 注意：ugcfx/bup 会被 bilibili 路由到 ugcfxever bucket（bupfetch 协议），不接受 multipart init。
const PROFILE = 'ugcupos/bup';

// 上行 CDN 偏好。可选: bda2（百度云）/ alia（阿里云）/ txa（腾讯云）。
// 国内默认 bda2 即可；海外用户走阿里走得更稳。可以通过环境变量 PLIVE_UPLOAD_CDN 覆盖。
const PREFERRED_CDN = process.env.PLIVE_UPLOAD_CDN || 'alia';

/**
 * Step 1: 询问 upload server。
 */
async function preupload(filename, size) {
  const url = new URL('https://member.bilibili.com/preupload');
  url.searchParams.set('name', filename);
  url.searchParams.set('size', String(size));
  url.searchParams.set('r', 'upos');
  url.searchParams.set('profile', PROFILE);
  url.searchParams.set('ssl', '0');
  url.searchParams.set('version', '2.10.4');
  url.searchParams.set('build', '2100400');
  url.searchParams.set('upcdn', PREFERRED_CDN);
  url.searchParams.set('probe_version', '20221109');
  const r = await biliFetch(url.toString());
  if (!r.ok) throw new Error(`preupload HTTP ${r.status}`);
  const j = await r.json();
  if (j.OK !== 1) throw new Error(`preupload failed: ${JSON.stringify(j)}`);
  // upos_uri 形如 "upos://ugcfx2lf/n123456789.flv"
  // endpoint 形如 "//upos-cs-upcdnbda2.bilivideo.com"
  const uposParts = j.upos_uri.replace(/^upos:\/\//, '').split('/'); // ["ugcfx2lf", "n123456789.flv"]
  const bucket = uposParts[0];
  const objectName = uposParts.slice(1).join('/');
  // preupload 一般返回多个候选 endpoint（不同 CDN 厂商的）。primary 节点抽风时
  // init 阶段会自动 fallback 到下一个；chunk/complete 必须沿用同一个（已经 init 过）。
  // 把 PREFERRED_CDN 对应的 endpoint 排到最前（B 站可能不一定按我们 upcdn 参数排序）。
  const rawEndpoints = (j.endpoints && j.endpoints.length ? j.endpoints : [j.endpoint])
    .map(e => 'https:' + e);
  const endpoints = [
    ...rawEndpoints.filter(e => e.includes(PREFERRED_CDN)),
    ...rawEndpoints.filter(e => !e.includes(PREFERRED_CDN)),
  ];
  return {
    endpoint: endpoints[0],                          // 偏好的 CDN 排第一
    endpoints,                                       // 全部候选（偏好的优先）
    uposPath: `/${bucket}/${objectName}`,
    bucket,
    objectName,
    bizId: j.biz_id,
    auth: j.auth,
    chunkSize: j.chunk_size,
    threads: j.threads || 3,
    uposUri: j.upos_uri,
    // put_query 形如 "os=upos&profile=ugcfx%2Fbup"，init/PUT/complete 都得带，否则 InvalidArgument
    putQuery: j.put_query || '',
  };
}

/**
 * Step 2: init multipart upload, 拿 upload_id。
 * 主 endpoint 失败/超时（节点抽风）时自动尝试下一个 endpoint。
 * @returns { uploadId, endpoint } 实际成功的 endpoint，后续 chunk/complete 沿用
 */
async function initUpload(info) {
  let lastErr = null;
  for (const endpoint of info.endpoints) {
    const url = `${endpoint}${info.uposPath}?uploads&output=json&${info.putQuery}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Upos-Auth': info.auth,
          'User-Agent': 'Mozilla/5.0 plive',
        },
        signal: AbortSignal.timeout(60_000),    // 60s 不响应 → 视为节点抽风换下一个
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`init HTTP ${r.status}: ${body.slice(0, 300)}`);
      }
      const j = await r.json();
      if (!j.upload_id) throw new Error(`init no upload_id: ${JSON.stringify(j)}`);
      console.log(`[upload] init ok on ${endpoint}`);
      return { uploadId: j.upload_id, endpoint };
    } catch (e) {
      lastErr = e;
      console.warn(`[upload] init failed on ${endpoint}: ${e.message}, 尝试下一个 endpoint`);
    }
  }
  throw new Error(`init failed on all ${info.endpoints.length} endpoints: ${lastErr?.message}`);
}

/**
 * Step 3: 分片上传。numbered from 1.
 * @param chunk Buffer
 * @param chunkIndex 0-based for `chunk` query param; partNumber = chunkIndex+1
 */
async function uploadChunk(info, uploadId, chunkIndex, totalChunks, chunk, fileTotalSize, fileStart) {
  const partNumber = chunkIndex + 1;
  const url = `${info.endpoint}${info.uposPath}` +
    `?partNumber=${partNumber}&uploadId=${uploadId}` +
    `&chunk=${chunkIndex}&chunks=${totalChunks}` +
    `&size=${chunk.length}&start=${fileStart}&end=${fileStart + chunk.length}` +
    `&total=${fileTotalSize}&${info.putQuery}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Upos-Auth': info.auth,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'Mozilla/5.0 plive',
    },
    body: chunk,
    signal: AbortSignal.timeout(180_000),     // 单个 chunk 3 分钟超时（10MB 大）
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`chunk ${partNumber} HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  const text = await r.text();
  return text; // 一般是 'MULTIPART_PUT_SUCCESS'，eTag 我们不收，complete 时用 partNumber 复述
}

/**
 * Step 4: complete multipart.
 */
async function completeUpload(info, uploadId, totalChunks, filename) {
  const parts = [];
  for (let i = 1; i <= totalChunks; i++) {
    parts.push({ partNumber: i, eTag: 'etag' });
  }
  const url = `${info.endpoint}${info.uposPath}` +
    `?output=json&name=${encodeURIComponent(filename)}` +
    `&profile=${encodeURIComponent(PROFILE)}` +
    `&uploadId=${uploadId}&biz_id=${info.bizId}` +
    `&${info.putQuery}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Upos-Auth': info.auth,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 plive',
    },
    body: JSON.stringify({ parts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`complete HTTP ${r.status}: ${body.slice(0, 500)}`);
  }
  const j = await r.json();
  if (j.OK !== 1) throw new Error(`complete failed: ${JSON.stringify(j)}`);
  return j;
}

/**
 * Step 5: submit video, 返回 BV id。
 */
export async function submitVideo({ uposUri, title, tid, tag, copyright, source, desc, coverUrl }) {
  const csrf = getCsrf();
  if (!csrf) throw new Error('not logged in (no bili_jct cookie)');
  // upos_uri "upos://ugcfx2lf/n123456789.flv" → filename "n123456789"
  const filename = uposUri.replace(/^upos:\/\/[^/]+\//, '').replace(/\.[^.]+$/, '');
  const body = {
    copyright,                              // 1=自制 2=转载
    source: copyright === 2 ? (source || '') : '',
    title,
    tid,
    tag,
    desc: desc || '',
    cover: coverUrl || '',                  // 后续可加：上传封面拿到 url
    videos: [{ filename, title, desc: '' }],
    no_reprint: 0,
    open_elec: 0,
  };
  const url = `https://member.bilibili.com/x/vu/web/add?csrf=${encodeURIComponent(csrf)}`;
  const r = await biliFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`submit HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`submit code=${j.code} msg=${j.message}`);
  return { aid: j.data.aid, bvid: j.data.bvid };
}

/**
 * 高层封装：上传一个本地文件 → 返回 upos_uri。再单独调 submitVideo。
 *
 * @param filePath 本地路径
 * @param onProgress({ phase, uploadedBytes, totalBytes, percent, currentChunk, totalChunks })
 *                  phase: 'preupload' | 'init' | 'uploading' | 'completing'
 */
export async function uploadFile(filePath, onProgress = () => {}) {
  const st = await stat(filePath);
  const size = st.size;
  const filename = basename(filePath);

  onProgress({ phase: 'preupload', uploadedBytes: 0, totalBytes: size, percent: 0 });
  const info = await preupload(filename, size);

  onProgress({ phase: 'init', uploadedBytes: 0, totalBytes: size, percent: 0 });
  const { uploadId, endpoint: pickedEndpoint } = await initUpload(info);
  // 把 info.endpoint 切换成实际成功的那个，后续 chunk/complete 沿用
  info.endpoint = pickedEndpoint;

  const chunkSize = info.chunkSize;
  const totalChunks = Math.ceil(size / chunkSize);
  let uploaded = 0;

  // 用 info.threads 做 chunk 并发（preupload 给的，常见 3）。下面是简化的
  // 顺序+重试版本（每个 chunk 5 次重试 + 1/2/4/8/16s 指数退避，专门扛 5xx 抽风）。
  const MAX_CHUNK_RETRIES = 5;
  const fh = await open(filePath, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const thisChunkSize = Math.min(chunkSize, size - start);
      const buf = Buffer.alloc(thisChunkSize);
      await fh.read(buf, 0, thisChunkSize, start);

      let lastErr = null;
      let attemptUsed = 0;
      for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        attemptUsed = attempt + 1;
        // 重试时也把 attempt 数据吐给 UI
        if (attempt > 0) {
          onProgress({
            phase: 'uploading',
            uploadedBytes: uploaded,
            totalBytes: size,
            currentChunk: i + 1,
            totalChunks,
            currentChunkAttempt: attempt + 1,
            maxChunkAttempts: MAX_CHUNK_RETRIES,
            percent: (uploaded / size) * 100,
          });
        }
        try {
          await uploadChunk(info, uploadId, i, totalChunks, buf, size, start);
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          // 4xx 客户端错误一般是 token 失效之类，不重试
          const m = String(e.message).match(/HTTP (\d+)/);
          const code = m ? Number(m[1]) : 0;
          if (code >= 400 && code < 500) break;
          // 5xx / 网络错误：指数退避 1/2/4/8/16 秒
          const wait = 1000 * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, wait));
        }
      }
      if (lastErr) throw lastErr;

      uploaded += thisChunkSize;
      onProgress({
        phase: 'uploading',
        uploadedBytes: uploaded,
        totalBytes: size,
        currentChunk: i + 1,
        totalChunks,
        currentChunkAttempt: attemptUsed,
        maxChunkAttempts: MAX_CHUNK_RETRIES,
        percent: (uploaded / size) * 100,
      });
    }
  } finally {
    await fh.close();
  }

  onProgress({ phase: 'completing', uploadedBytes: size, totalBytes: size, percent: 100 });
  await completeUpload(info, uploadId, totalChunks, filename);
  return { uposUri: info.uposUri, filename };
}
