#!/bin/bash
# plive 一键安装脚本（原生模式，不用 docker）
#
# 适用：Linux x86_64 / arm64，已装好 Node 20+、git、unzip、tar
# 步骤：
#   1. 检查环境
#   2. npm install（后端 + 前端）
#   3. npm run build（前端构建）
#   4. node scripts/setup.js（下载 BR + DanmakuFactory 二进制）
#   5. 生成 config.json（不存在时）
#   6. 可选：写 systemd unit 并 enable
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/wc279956766/plive/main/deploy/install.sh | bash
# 或：
#   git clone https://github.com/wc279956766/plive && cd plive && bash deploy/install.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
log()  { echo -e "${GREEN}[plive]${NC} $*"; }
warn() { echo -e "${YELLOW}[plive]${NC} $*"; }
err()  { echo -e "${RED}[plive]${NC} $*"; }

# === 1. 环境检查 ===
log "检查环境..."

NEED=(node npm unzip tar)
MISSING=()
for c in "${NEED[@]}"; do
  command -v "$c" >/dev/null 2>&1 || MISSING+=("$c")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  err "缺少依赖: ${MISSING[*]}"
  err "Ubuntu/Debian: sudo apt install -y nodejs npm unzip tar"
  err "Node 版本必须 >=20，可用 nvm 或 NodeSource 源安装"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node 版本太低: $(node -v)，需要 >= 20"
  err "推荐 nvm install 22 或者 NodeSource 源"
  exit 1
fi
log "  node $(node -v) ✓"

# === 2. 找项目根目录 ===
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_ROOT"

if [ ! -f "package.json" ]; then
  err "在 $PROJECT_ROOT 没找到 package.json，install.sh 必须从项目目录跑"
  exit 1
fi
log "项目目录: $PROJECT_ROOT"

# === 3. 后端 npm install ===
log "安装后端依赖（含 better-sqlite3 编译，较慢）..."
npm install --no-audit --no-fund

# === 4. 前端 build ===
log "构建前端..."
( cd web && npm install --no-audit --no-fund && npm run build )

# === 5. 下载二进制 ===
log "下载 BililiveRecorder + DanmakuFactory 到 ./bin..."
node scripts/setup.js

# === 6. 生成 config.json ===
if [ ! -f "config.json" ]; then
  cp config.example.json config.json
  log "已生成 config.json（按 config.example.json）"
else
  log "config.json 已存在，跳过生成"
fi

log ""
log "安装完成。"
log ""
log "启动："
log "  npm start"
log ""
log "默认监听 http://0.0.0.0:9090"
log ""

# === 7. 可选 systemd ===
if [ -d /etc/systemd/system ] && [ "$(id -u)" -ne 0 ]; then
  read -p "是否写 systemd unit (需 sudo)？[y/N] " -n 1 -r REPLY
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    UNIT_FILE="/etc/systemd/system/plive.service"
    USER_NAME=$(whoami)
    NODE_BIN=$(command -v node)
    sudo tee "$UNIT_FILE" > /dev/null <<EOF
[Unit]
Description=plive — Bilibili 直播自动录制 + 上传 + 切片
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$PROJECT_ROOT
ExecStart=$NODE_BIN $PROJECT_ROOT/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now plive
    log "已 enable plive.service，sudo systemctl status plive 查看状态"
  fi
fi
