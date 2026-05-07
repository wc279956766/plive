import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadConfig() {
  // 优先级：PLIVE_CONFIG 环境变量 > <projectRoot>/config.json > <projectRoot>/config.example.json
  const envPath = process.env.PLIVE_CONFIG;
  const userPath = resolve(projectRoot, 'config.json');
  const examplePath = resolve(projectRoot, 'config.example.json');
  const path = (envPath && existsSync(envPath)) ? envPath
             : existsSync(userPath)             ? userPath
             :                                    examplePath;
  const cfg = JSON.parse(readFileSync(path, 'utf8'));

  // resolve relative paths against projectRoot
  for (const k of ['dataDir', 'binDir']) {
    if (cfg.paths[k] && !cfg.paths[k].startsWith('/')) {
      cfg.paths[k] = resolve(projectRoot, cfg.paths[k]);
    }
  }
  if (cfg.bilibili?.uploadCookiePath && !cfg.bilibili.uploadCookiePath.startsWith('/')) {
    cfg.bilibili.uploadCookiePath = resolve(projectRoot, cfg.bilibili.uploadCookiePath);
  }
  cfg._projectRoot = projectRoot;
  return cfg;
}

export const config = loadConfig();
