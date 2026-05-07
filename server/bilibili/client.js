// 统一的 B 站 HTTP 客户端：自动带 cookie + UA + Referer。
import { loadCookies, cookiesToHeader } from './auth.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 plive/0.0.1';

function buildHeaders(extra = {}) {
  const cookies = loadCookies();
  const h = {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    ...extra,
  };
  if (cookies) h['Cookie'] = cookiesToHeader(cookies);
  return h;
}

export function getCsrf() {
  const cookies = loadCookies();
  return cookies?.bili_jct || null;
}

export async function biliFetch(url, opts = {}) {
  const headers = buildHeaders(opts.headers || {});
  const r = await fetch(url, { ...opts, headers });
  return r;
}

/** GET 并解析 JSON，code=0 才返回 data，否则抛错 */
export async function biliJson(url, opts = {}) {
  const r = await biliFetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const j = await r.json();
  if (j.code !== 0) {
    const e = new Error(`bilibili api code=${j.code} msg=${j.message || j.msg}`);
    e.code = j.code; e.body = j;
    throw e;
  }
  return j.data;
}
