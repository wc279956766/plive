#!/usr/bin/env node
/**
 * Setup script: download BililiveRecorder.Cli (and biliup-rs in Phase 3) to ./bin/
 *
 * Usage:
 *   node scripts/setup.js              # downloads everything
 *   node scripts/setup.js br           # only BililiveRecorder.Cli
 */
import { mkdirSync, createWriteStream, existsSync, chmodSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = resolve(projectRoot, 'bin');
mkdirSync(binDir, { recursive: true });

const want = process.argv[2] || 'all';

function platformAssetSuffix() {
  const a = process.arch === 'arm64' ? 'arm64'
          : process.arch === 'arm'   ? 'arm'
          : 'x64';
  if (process.platform === 'linux') return `linux-${a}`;
  if (process.platform === 'darwin') return `osx-${a}`;
  if (process.platform === 'win32')  return `win-${a}`;
  throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'plive-setup' } });
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.json();
}

async function downloadFile(url, outPath) {
  console.log(`  ↓ ${url}`);
  const r = await fetch(url, { headers: { 'User-Agent': 'plive-setup' } });
  if (!r.ok) throw new Error(`download ${url} → HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(outPath));
}

async function setupBililiveRecorder() {
  const targetDir = resolve(binDir, 'BililiveRecorder');
  if (existsSync(resolve(targetDir, 'BililiveRecorder.Cli'))) {
    console.log('[BR] already installed, skip');
    return;
  }
  console.log('[BR] fetching latest release...');
  const release = await fetchJson('https://api.github.com/repos/BililiveRecorder/BililiveRecorder/releases/latest');
  const wantSuffix = platformAssetSuffix();
  const asset = release.assets.find(a => a.name === `BililiveRecorder-CLI-${wantSuffix}.zip`);
  if (!asset) throw new Error(`no asset for ${wantSuffix}`);
  console.log(`[BR] ${release.tag_name} → ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
  const zipPath = resolve(tmpdir(), asset.name);
  await downloadFile(asset.browser_download_url, zipPath);
  // unzip via system unzip command (Linux/macOS) — POSIX. For win we'd use a JS unzip lib.
  mkdirSync(targetDir, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', targetDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('unzip failed (apt install unzip)');
  rmSync(zipPath, { force: true });
  // make CLI executable
  const cli = resolve(targetDir, 'BililiveRecorder.Cli');
  if (existsSync(cli)) chmodSync(cli, 0o755);
  console.log(`[BR] installed at ${targetDir}`);
}

async function setupBiliup() {
  const targetBin = resolve(binDir, 'biliup');
  if (existsSync(targetBin)) {
    console.log('[biliup] already installed, skip');
    return;
  }
  console.log('[biliup] fetching latest release...');
  // biliup-rs 已 archived，统一在 biliup/biliup 维护
  const release = await fetchJson('https://api.github.com/repos/biliup/biliup/releases/latest');
  // 选 linux x86_64 glibc 版（musl 可用作 fallback）
  const archMap = { x64: 'x86_64', arm64: 'aarch64', arm: 'arm' };
  const arch = archMap[process.arch];
  const platform = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'macos' : 'windows';
  const ext = platform === 'windows' ? '.zip' : '.tar.xz';
  const wantSuffix = `${arch}-${platform}${ext}`;
  const asset = release.assets.find(a => a.name.endsWith(wantSuffix));
  if (!asset) throw new Error(`no asset for ${wantSuffix}`);
  console.log(`[biliup] ${release.tag_name} → ${asset.name} (${(asset.size / 1024).toFixed(0)} KB)`);
  const arcPath = resolve(tmpdir(), asset.name);
  await downloadFile(asset.browser_download_url, arcPath);
  // tar -xJf 到 tmp，然后挑出 biliup 二进制扔到 bin/
  const tmpExtract = resolve(tmpdir(), 'biliup-extract-' + Date.now());
  mkdirSync(tmpExtract, { recursive: true });
  const r = spawnSync('tar', ['-xJf', arcPath, '-C', tmpExtract], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar -xJf failed');
  // 二进制名叫 biliup（释放后位于 tmp 子目录里）
  function findBin(dir) {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isFile() && name === 'biliup') return p;
      if (st.isDirectory()) { const f = findBin(p); if (f) return f; }
    }
    return null;
  }
  const found = findBin(tmpExtract);
  if (!found) throw new Error('biliup binary not found in archive');
  renameSync(found, targetBin);
  chmodSync(targetBin, 0o755);
  rmSync(tmpExtract, { recursive: true, force: true });
  rmSync(arcPath, { force: true });
  console.log(`[biliup] installed at ${targetBin}`);
}

async function setupDanmakuFactory() {
  const target = resolve(binDir, 'DanmakuFactory');
  if (existsSync(target)) {
    console.log('[DanmakuFactory] already installed, skip');
    return;
  }
  console.log('[DanmakuFactory] fetching dev release...');
  // 稳定版只有 Windows 二进制，Linux 在 'dev' tag
  const release = await fetchJson('https://api.github.com/repos/hihkm/DanmakuFactory/releases/tags/dev');
  const archMap = { x64: 'x86_64', arm64: 'arm64' };
  const arch = archMap[process.arch];
  const platform = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'macosx' : 'windows';
  const ext = platform === 'windows' ? '.zip' : '.tar.gz';
  const wantSuffix = `${platform}-${arch}-CLI${ext}`;
  const asset = release.assets.find(a => a.name.endsWith(wantSuffix));
  if (!asset) throw new Error(`no DanmakuFactory asset for ${wantSuffix}`);
  console.log(`[DanmakuFactory] ${release.name || release.tag_name} → ${asset.name} (${(asset.size / 1024).toFixed(0)} KB)`);
  const arcPath = resolve(tmpdir(), asset.name);
  await downloadFile(asset.browser_download_url, arcPath);
  const tmpExtract = resolve(tmpdir(), 'df-extract-' + Date.now());
  mkdirSync(tmpExtract, { recursive: true });
  const r = spawnSync('tar', ['-xzf', arcPath, '-C', tmpExtract], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar -xzf failed');
  // 找 DanmakuFactory 二进制
  function findBin(dir) {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isFile() && name === 'DanmakuFactory') return p;
      if (st.isDirectory()) { const f = findBin(p); if (f) return f; }
    }
    return null;
  }
  const found = findBin(tmpExtract);
  if (!found) throw new Error('DanmakuFactory binary not found');
  renameSync(found, target);
  chmodSync(target, 0o755);
  rmSync(tmpExtract, { recursive: true, force: true });
  rmSync(arcPath, { force: true });
  console.log(`[DanmakuFactory] installed at ${target}`);
}

const tasks = {
  br:      setupBililiveRecorder,
  biliup:  setupBiliup,
  danmaku: setupDanmakuFactory,
  all:     async () => {
    await setupBililiveRecorder();
    await setupDanmakuFactory();
    // biliup 我们没用（自己 Node 实现的协议），跳过
  },
};

if (!tasks[want]) {
  console.error(`unknown target: ${want}`);
  process.exit(1);
}
await tasks[want]();
console.log('done');
