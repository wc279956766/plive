import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // dev 时把 /api/* 转发到 fastify (port 9090)
      '/api': 'http://127.0.0.1:9090',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
