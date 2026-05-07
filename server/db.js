import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

mkdirSync(config.paths.dataDir, { recursive: true });
const dbPath = resolve(config.paths.dataDir, 'plive.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,            -- bilibili room_id
    name TEXT,                         -- streamer name (cached)
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,                  -- 'live' | 'offline' | null
    last_status_at INTEGER,            -- unix epoch sec
    auto_upload INTEGER NOT NULL DEFAULT 1,
    upload_template_json TEXT,         -- biliup config snippet (title, tag, tid, ...)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,           -- absolute path
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    size_bytes INTEGER,
    duration_sec INTEGER,
    upload_status TEXT NOT NULL DEFAULT 'pending',  -- pending | uploading | success | failed | skipped
    upload_log TEXT,
    bilibili_bvid TEXT,                -- BV id after success
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rec_room ON recordings(room_id);
  CREATE INDEX IF NOT EXISTS idx_rec_status ON recordings(upload_status);

  CREATE TABLE IF NOT EXISTS slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_recording_id INTEGER REFERENCES recordings(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    title TEXT,                                    -- 用户起的切片标题/重命名
    start_sec REAL NOT NULL,                       -- 在源录像里的起点（秒）
    end_sec REAL NOT NULL,                         -- 终点
    duration_sec REAL,
    size_bytes INTEGER,
    burn_danmaku INTEGER NOT NULL DEFAULT 0,       -- 0=纯净 1=已烧弹幕
    upload_status TEXT NOT NULL DEFAULT 'pending', -- pending | uploading | success | failed | skipped
    upload_log TEXT,
    bilibili_bvid TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_slice_src ON slices(source_recording_id);
`);

// （已移除 record_danmaku 列：弹幕始终录到 .xml，是否带弹幕在上传/切片阶段决定）

export function now() { return Math.floor(Date.now() / 1000); }
