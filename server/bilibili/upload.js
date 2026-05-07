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
  url.searchParams.set('upcdn', 'bda2');
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
  return {
    endpoint: 'https:' + j.endpoint,                // 拼成完整 https 域
    uposPath: `/${bucket}/${objectName}`,           // PUT/POST 用的 path
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
 */
async function initUpload(info) {
  const url = `${info.endpoint}${info.uposPath}?uploads&output=json&${info.putQuery}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Upos-Auth': info.auth,
      'User-Agent': 'Mozilla/5.0 plive',
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`init HTTP ${r.status}: ${body.slice(0, 500)}`);
  }
  const j = await r.json();
  if (!j.upload_id) throw new Error(`init no upload_id: ${JSON.stringify(j)}`);
  return j.upload_id;
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
 * @param onProgress({ uploadedBytes, totalBytes, percent })
 */
export async function uploadFile(filePath, onProgress = () => {}) {
  const st = await stat(filePath);
  const size = st.size;
  const filename = basename(filePath);

  const info = await preupload(filename, size);
  const uploadId = await initUpload(info);

  const chunkSize = info.chunkSize;
  const totalChunks = Math.ceil(size / chunkSize);
  let uploaded = 0;

  const fh = await open(filePath, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const thisChunkSize = Math.min(chunkSize, size - start);
      const buf = Buffer.alloc(thisChunkSize);
      await fh.read(buf, 0, thisChunkSize, start);
      // 简单重试 3 次
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await uploadChunk(info, uploadId, i, totalChunks, buf, size, start);
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
      uploaded += thisChunkSize;
      onProgress({
        uploadedBytes: uploaded,
        totalBytes: size,
        percent: (uploaded / size) * 100,
      });
    }
  } finally {
    await fh.close();
  }

  await completeUpload(info, uploadId, totalChunks, filename);
  return { uposUri: info.uposUri, filename };
}
