import { loginWithCookieString, fetchSelf, clearCookies, loadCookies } from '../bilibili/auth.js';
import { reloadRecorder } from '../recorder.js';

export default async function routes(fastify) {
  fastify.get('/api/bilibili/me', async () => {
    const cookies = loadCookies();
    if (!cookies) return { logged_in: false };
    const user = await fetchSelf(cookies);
    if (!user || !user.isLogin) return { logged_in: false, expired: !!cookies };
    return { logged_in: true, user };
  });

  fastify.post('/api/bilibili/login', async (req, reply) => {
    const { cookies } = req.body || {};
    if (typeof cookies !== 'string' || !cookies.trim()) {
      return reply.code(400).send({ error: 'cookies (string) required' });
    }
    const r = await loginWithCookieString(cookies);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    reloadRecorder();   // 让 BR 拿到新 cookie 后重启，下次开播能用最高画质
    return { ok: true, user: r.user };
  });

  fastify.post('/api/bilibili/logout', async () => {
    clearCookies();
    reloadRecorder();
    return { ok: true };
  });
}
