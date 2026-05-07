// B 站登录态：用户粘贴 cookie 字符串 → 解析 → 持久化 → 验证 → 复用
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

const COOKIE_PATH = config.bilibili.uploadCookiePath;

// 上传必需的 cookie 字段
const REQUIRED = ['SESSDATA', 'bili_jct', 'DedeUserID'];

/** 解析浏览器 DevTools 风格的 cookie 字符串成 { name: value } */
export function parseCookieString(s) {
  const out = {};
  for (const pair of (s || '').split(/[;\n]+/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

/** 把 cookie 对象序列化成 HTTP Cookie header 用的字符串 */
export function cookiesToHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

let cached = null;

export function loadCookies() {
  if (cached) return cached;
  if (!existsSync(COOKIE_PATH)) return null;
  try {
    cached = JSON.parse(readFileSync(COOKIE_PATH, 'utf8'));
    return cached;
  } catch {
    return null;
  }
}

export function saveCookies(cookies) {
  mkdirSync(dirname(COOKIE_PATH), { recursive: true });
  writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  cached = cookies;
}

export function clearCookies() {
  cached = null;
  if (existsSync(COOKIE_PATH)) unlinkSync(COOKIE_PATH);
}

/**
 * 验证当前 cookie 是否有效，并返回用户信息。
 * 失败抛错或返回 null。
 */
export async function fetchSelf(cookies = null) {
  const c = cookies || loadCookies();
  if (!c) return null;
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) plive',
      'Cookie': cookiesToHeader(c),
      'Referer': 'https://www.bilibili.com/',
    },
  });
  if (!r.ok) return null;
  const j = await r.json();
  // code 0 = 已登录，-101 = 未登录
  if (j.code !== 0) return null;
  const d = j.data || {};
  return {
    mid: d.mid,
    uname: d.uname,
    avatar: d.face,
    level: d.level_info?.current_level,
    coin: d.money,
    isLogin: !!d.isLogin,
  };
}

/**
 * 接受 cookie 字符串（可来自浏览器 DevTools 拷贝）→ 验证 → 保存。
 * 返回 { ok, user?, error? }
 */
export async function loginWithCookieString(cookieStr) {
  const parsed = parseCookieString(cookieStr);
  for (const k of REQUIRED) {
    if (!parsed[k]) return { ok: false, error: `cookie 缺少字段：${k}` };
  }
  const user = await fetchSelf(parsed);
  if (!user || !user.isLogin) {
    return { ok: false, error: '验证失败：cookie 无效或已过期' };
  }
  saveCookies(parsed);
  return { ok: true, user };
}
