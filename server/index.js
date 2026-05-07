import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import roomsRoutes from './routes/rooms.js';
import recordingsRoutes from './routes/recordings.js';
import slicesRoutes from './routes/slices.js';
import slicerRoutes from './routes/slicer.js';
import webhookRoutes from './routes/webhook.js';
import bilibiliRoutes from './routes/bilibili.js';
import uploadsRoutes from './routes/uploads.js';
import { startMonitor, stopMonitor } from './workers/monitor.js';
import { startUploader, stopUploader } from './workers/uploader.js';
import { startCleanup, stopCleanup } from './workers/cleanup.js';
import { startRecorder, stopRecorder, syncRoomsToBR } from './recorder.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(roomsRoutes);
await app.register(recordingsRoutes);
await app.register(slicesRoutes);
await app.register(slicerRoutes);
await app.register(webhookRoutes);
await app.register(bilibiliRoutes);
await app.register(uploadsRoutes);

app.get('/api/health', async () => ({ ok: true, version: '0.0.1' }));

// 托管前端构建产物（如果存在），并对 SPA 路由 fallback 到 index.html
const webDist = resolve(config._projectRoot, 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(`<!doctype html><meta charset=utf-8>
<title>plive</title>
<h1>plive (no web build)</h1>
<p>前端尚未构建。运行 <code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code>，或 <code>npm run dev</code> 起开发服务器。</p>
<p>API 已就绪：<a href="/api/health">/api/health</a></p>`);
  });
}

async function shutdown() {
  stopMonitor();
  stopUploader();
  stopCleanup();
  await stopRecorder();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.server.host, port: config.server.port });
startMonitor();
startRecorder();
startUploader();
startCleanup();

// 等 BR 起来后再做一次房间同步：BR 启动时读旧 config.json 可能漏房间，
// 这里用 HTTP API 把 DB 状态推过去对齐。
setTimeout(() => syncRoomsToBR().catch(e => app.log.error(e)), 8000);
