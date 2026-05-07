# plive

B 站直播全自动录制 → 上传 → 切片管理的 Web 服务，单 Node.js 进程跑全套。

面向自托管服务器场景，不是给一般家用机用户的："你能拿到 cookie，能编辑配置文件" 是基本前提。

## 主要功能

- **房间监控**：周期轮询 B 站 API，识别开/关播
- **自动录制**：开播后调 [BililiveRecorder.Cli](https://github.com/BililiveRecorder/BililiveRecorder) 录制，带 cookie 解锁原画/4K/杜比
- **自动上传**：录完后用 cookie 走 UPOS 协议直传 B 站，房间级模板渲染元数据
- **切片器**：从录像选起止时间点切一段，可选无损纯净（快）或烧入弹幕（重编码慢）
- **三切一合并**：多个切片排序后无损 concat 成一个视频
- **手动上传**：每段录像/切片都能弹窗里改标题、tag、简介、版权后再投
- **本地保留 7 天**：上传成功的录像自动清理本地 `.flv` 和 `.xml`，切片永远手动删

## 技术栈

- **后端**：Node.js 20+ / Fastify 5 / better-sqlite3
- **前端**：Vue 3 + Vite + Vue Router
- **第三方二进制**（自动下载到 `bin/`）：
  - [BililiveRecorder.Cli](https://github.com/BililiveRecorder/BililiveRecorder) — 录制
  - [DanmakuFactory](https://github.com/hihkm/DanmakuFactory) — 弹幕 xml→ass
  - ffmpeg / ffprobe — 来自 `ffmpeg-static` / `ffprobe-static` npm 包
- **B 站上传**：自己用 Node 实现 UPOS 协议（preupload + 分片 PUT + complete + submit），不依赖外部 biliup 二进制

## 快速开始

### 方式 A：一键脚本（原生，推荐）

```bash
git clone https://github.com/wc279956766/plive
cd plive
bash deploy/install.sh
```

`install.sh` 会：检查 Node 版本 → 装依赖 → 构建前端 → 下载 BR/DanmakuFactory 二进制 → 生成 config → 可选写 systemd unit。

启动后打开 `http://<host>:9090`。

> 前置：`Node 20+`、`unzip`、`tar`。Ubuntu/Debian：`sudo apt install -y nodejs npm unzip tar`（推荐 NodeSource 源或 nvm 装新版 Node）。

### 方式 B：Docker

```bash
git clone https://github.com/wc279956766/plive
cd plive
docker compose up -d
```

挂载点：

| 路径 | 用途 |
|---|---|
| `./data/config` | sqlite + cookie + BR workdir + 切片产物 |
| `./data/recordings` | 录像 `.flv/.xml` 落盘位置 |

时区 / 用户改 `docker-compose.yml` 里的 `TZ` / `PUID` / `PGID`。

### 方式 C：手动

```bash
git clone https://github.com/wc279956766/plive
cd plive
npm install
( cd web && npm install && npm run build )
npm run setup            # 下载 BR + DanmakuFactory 到 ./bin
cp config.example.json config.json
npm start
```

## 配置

`config.json`：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 9090
  },
  "paths": {
    "recordingsDir": "./recordings",          // 录像落盘位置（相对/绝对路径都行）
    "dataDir": "./data",                       // sqlite + 切片产物 + BR workdir
    "binDir": "./bin"                          // 第三方二进制
  },
  "monitor": {
    "intervalSec": 30                          // 监控轮询间隔
  },
  "retention": {
    "recordingDays": 7                         // 上传成功后保留多久
  },
  "bilibili": {
    "uploadCookiePath": "./data/bilibili-cookie.json"
  }
}
```

## 使用流程

### 1. 登录 B 站

进 `/settings`，按页面提示从浏览器复制 cookie 字符串粘进去。最少需要 `SESSDATA`、`bili_jct`、`DedeUserID` 三个字段。

成功后会显示用户名 + 头像，cookie 持久化到磁盘 (`data/bilibili-cookie.json`)。**Cookie 同时用于上传 和 BR 录制（解锁高画质）**。登录态变化会自动重启 BR 让新 cookie 生效。

### 2. 加监控房间

进 `/rooms`，输入 B 站直播房间号（直播间 URL 末尾那个数字），点添加。监控 worker 会在下次轮询 (~30s) 内拿到主播名/状态。

### 3. 配投稿模板

每个房间都有自己的模板，点 `投稿模板` 按钮编辑：

- **分区 ID (tid)**：B 站分区号，如 21=日常 / 27=综合 / 17=单机游戏
- **版权**：自制 / 转载（直播录像通常选转载）
- **转载源 URL**：转载时填，会显示在投稿页底部
- **标题模板**：用占位符自由组合
- **标签**：逗号分隔
- **简介**：自由文本

支持的占位符：

| 占位符 | 含义 |
|---|---|
| `{name}` | 主播名 |
| `{roomId}` | 房间号 |
| `{title}` | 直播标题（从录像文件名解析；主播名或标题含 `-` 时可能错位） |
| `{date}` | 录制日期 `2026-05-05` |
| `{datetime}` | `2026-05-05 14:30` |
| `{file}` | 源文件名（不含扩展名） |

### 4. 等开播

主播开播 → 监控 worker 检出 → BR 自动录制 → 关播后 webhook 入库 → 上传 worker 处理（如果房间开了 `自动上传`）。

也可以关掉自动上传，关播后到 `/library` 手动点 `上传`，弹窗里二次校对元数据再投。

### 5. 切片

`/library` 录像列表点 `切片` → 跳到切片器。

切片器：

- 选源录像（也能从下拉换）
- 视频播放器播一遍
- 按 `I` 设起点 / `O` 设终点（也能直接在输入框输 `01:23:45.500` 这种时间）
- 起名
- 可选 **烧入弹幕**：重新编码，慢；不勾则用 ffmpeg `-c copy` 无损切，秒级
- 保存

切片落到 `/slices`，可单独 `上传` 投稿。

### 6. 三切一合并

`/merge`：勾选多个切片 → 上下排序 → 起名 → `开始合并`。无损 ffmpeg concat，要求各段编码参数一致（同一录像切的没问题）。

合并产物自动加进 `/slices`，可继续上传。

### 7. 自动清理

后台 cleanup worker 每 6 小时扫一次：

- 上传成功且超过 `retention.recordingDays` 天的录像 → 删除 `.flv` 和 `.xml`
- 数据库行保留（用于查 BV 历史）
- **切片永不自动清理**

`/library` 上已清理的录像会显示 "已清理" badge，按钮自动隐藏。

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│ Node.js (Fastify, single process)                              │
│                                                                │
│   ┌─ HTTP Server :9090 ─┐                                      │
│   │ /api/...            │ ← Web UI (Vue 3, served from dist/)  │
│   └─────────────────────┘                                      │
│                                                                │
│   ┌─ Workers ─────────────────────────────┐                    │
│   │ monitor  (30s 轮询 B 站 API)          │                    │
│   │ recorder (管理 BR Cli 子进程)         │ ─→ BR Cli ─→ .flv  │
│   │ uploader (扫 pending 录像 → UPOS 上传)│                    │
│   │ cleanup  (6h 扫一次，删 7 天前的)     │                    │
│   └────────────────────────────────────────┘                   │
│                                                                │
│   ┌─ SQLite (better-sqlite3 + WAL) ─┐                          │
│   │ rooms / recordings / slices     │                          │
│   └─────────────────────────────────┘                          │
└────────────────────────────────────────────────────────────────┘
                          │
                          ↓
┌──────────────────────────────────────────────────┐
│ BR Cli (subprocess, http :9091 internal)         │
│  - 监听各房间弹幕服务器                          │
│  - 直播开始 → 拉流录到 .flv                      │
│  - 弹幕落 .xml （独立文件）                      │
│  - FileClosed → POST plive /api/recorder/webhook │
└──────────────────────────────────────────────────┘
```

数据流：

```
开播
  └── BR 拉流 → .flv + .xml 落盘
       └── BR webhook → plive 写 recordings 表 (status=pending)
            └── uploader worker 拉走 → UPOS 上传 → submit (status=success, bvid)
                 └── 7 天后 cleanup 删本地文件
```

## 部署

### systemd (推荐)

```ini
# /etc/systemd/system/plive.service
[Unit]
Description=plive
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=plive
WorkingDirectory=/opt/plive
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now plive
```

### Docker

`deploy/Dockerfile` 备用，但项目本身设计为 native 运行，docker 是辅助选项。

### 反向代理

如果要外网访问，前面套个 Caddy / Nginx 反代到 :9090 即可。**注意 cookie 是 SPOF**——B 站 cookie 失效就上传不了，记得在 `/settings` 重新粘贴。

## 开发

```bash
# 后端 watch 模式（自动重启）
npm run dev

# 前端 dev server（带热重载，代理 /api 到后端 :9090）
cd web && npm run dev
```

前端 dev server 默认 :5173。

## 已知限制

- `{title}` 占位符靠正则解析文件名，主播名或标题含 `-` 会错位。短期内可在上传弹窗里手改，长期方案是从 BR webhook 的 `EventData.Title` 里读
- 上传失败不会自动重试，需要在 `/library` 手动点 `上传`
- 切片合并不支持烧弹幕（合并的是已成切片的，弹幕信息已与源解耦）。要带弹幕的合并版，先各段都烧弹幕、再合并

## 安全注意

- `data/bilibili-cookie.json` 含敏感凭据，**不要提交到 git**（已在 `.gitignore`）
- 服务器若暴露公网，建议套反代+认证；Web UI 自身没鉴权
- BR Cli 的 webhook 端点 `/api/recorder/webhook` 信任 localhost 调用，没鉴权——别让外网能直接 POST 到这上面（反代里挡掉）

## 致谢

本项目站在以下开源项目肩膀上：

- **[BililiveRecorder](https://github.com/BililiveRecorder/BililiveRecorder)（录播姬）** — 核心录制由它的 Cli 子进程完成；房间增删改通过它的 HTTP API 热加载；事件通过它的 V2 webhook 协议接收。
- **[DanmakuFactory](https://github.com/hihkm/DanmakuFactory)** — 弹幕 `.xml` → `.ass` 字幕文件转换。
- **[biliup](https://github.com/biliup/biliup) / [biliup-rs](https://github.com/biliup/biliup-rs)** — UPOS 上传协议参考（preupload → init → 分片 PUT → complete → submit 流程，profile 选型 `ugcupos/bup`）。
- **[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)** — B 站非官方 API 文档（直播间状态、视频投稿等接口）。
- **[LosslessCut](https://github.com/mifi/lossless-cut)** — 切片器交互思路启发，无损切割 + 关键帧对齐。
- **[flv.js](https://github.com/bilibili/flv.js)** — 浏览器端 FLV 实时回放（B 站官方开源）。
- **[ffmpeg](https://ffmpeg.org/) / ffprobe** — 视频切片 / 转码 / 时长探测。

## 协议

MIT
