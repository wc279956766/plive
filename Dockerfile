# plive — Bilibili 直播自动录制 + 上传 + 切片 Web 服务
#
# 多阶段构建：
#   1. web-build  - Vue 前端构建为静态产物
#   2. setup      - 在构建期跑一次 npm run setup 把 BR / DanmakuFactory 二进制下载好
#                   （写入镜像内 /app/bin，省去运行期网络下载）
#   3. final      - 干净运行时镜像
#
# 持久化：CONFIG_DIR (默认 /config)，sqlite + cookie + BR workdir 都在这里
# 录像目录：通过 RECORDINGS_DIR 环境变量指定（默认 /data/recordings）

# ===== Stage 1: 前端构建 =====
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build


# ===== Stage 2: 后端依赖 + 二进制下载 =====
FROM node:22-bookworm-slim AS setup
WORKDIR /app

# better-sqlite3 编译需要的工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates unzip tar curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev
COPY scripts/ ./scripts/

# 下载 BililiveRecorder + DanmakuFactory 到 ./bin/（由 scripts/setup.js 处理）
RUN node scripts/setup.js


# ===== Stage 3: 最终运行镜像 =====
FROM node:22-bookworm-slim

# 运行时依赖：
#   - libicu-dev: BR (.NET) 跑起来要 ICU
#   - ca-certificates: HTTPS 证书
#   - tini: PID 1 信号转发，子进程清理
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libicu-dev ca-certificates tini gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 plive \
 && useradd -u 1000 -g plive -m -s /bin/bash plive

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    RECORDINGS_DIR=/data/recordings \
    TZ=Asia/Shanghai \
    PUID=1000 \
    PGID=1000

WORKDIR /app

# 后端代码 + node_modules + 二进制（来自 setup 阶段）
COPY --from=setup  /app/node_modules ./node_modules
COPY --from=setup  /app/bin          ./bin
COPY                server/          ./server/
COPY                scripts/         ./scripts/
COPY                package.json config.example.json ./

# 前端构建产物
COPY --from=web-build /web/dist ./web/dist

# entrypoint：处理 PUID/PGID + config 引导
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/config", "/data"]

EXPOSE 9090

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
CMD ["node", "server/index.js"]
