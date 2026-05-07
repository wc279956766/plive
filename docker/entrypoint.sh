#!/bin/bash
# plive docker entrypoint
#
# 任务：
#   1. 按 PUID/PGID 调整 plive 用户的 uid/gid（让生成的文件归属宿主用户）
#   2. 首次启动时把 config.example.json 拷到 /config/config.json（不覆盖）
#   3. 把 RECORDINGS_DIR 写进 /config/config.json（如果用户没改）
#   4. 切到 plive 用户跑 CMD
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# 调 uid/gid
if [ "$(id -u plive)" != "$PUID" ]; then
  usermod -o -u "$PUID" plive >/dev/null
fi
if [ "$(id -g plive)" != "$PGID" ]; then
  groupmod -o -g "$PGID" plive >/dev/null
fi

# bootstrap config
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  echo "[entrypoint] generating $CONFIG_DIR/config.json from template"
  # 从 config.example.json 派生：
  #   - recordingsDir 用 $RECORDINGS_DIR
  #   - dataDir / binDir 用容器内固定路径
  node -e "
    const fs = require('fs');
    const tmpl = JSON.parse(fs.readFileSync('/app/config.example.json', 'utf-8'));
    tmpl.paths.recordingsDir = process.env.RECORDINGS_DIR || '/data/recordings';
    tmpl.paths.dataDir       = '$CONFIG_DIR';
    tmpl.paths.binDir        = '/app/bin';
    tmpl.bilibili.uploadCookiePath = '$CONFIG_DIR/bilibili-cookie.json';
    fs.writeFileSync('$CONFIG_DIR/config.json', JSON.stringify(tmpl, null, 2));
  "
fi

# 让 plive 进程能找到 config
export PLIVE_CONFIG="$CONFIG_DIR/config.json"

# 录像目录 + config 目录归属调整
mkdir -p "$RECORDINGS_DIR"
chown -R "$PUID:$PGID" "$CONFIG_DIR" "$RECORDINGS_DIR" 2>/dev/null || true
chown -R "$PUID:$PGID" /app/bin 2>/dev/null || true

# 切到 plive 用户跑 CMD
exec gosu plive "$@" 2>/dev/null || exec su -c "$*" plive
