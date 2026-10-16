-- ============================================================
--  作业记录 · 账号与同步 数据库结构 (Cloudflare D1 / SQLite)
--  设计原则：口令与令牌只存哈希，明文永不落库
-- ============================================================

DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS backup_codes;
DROP TABLE IF EXISTS sync_data;

-- 账号表：个人使用，但结构上支持多账号
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- 用户 ID
  username      TEXT NOT NULL UNIQUE,       -- 登录名，如 owner
  pwd_salt      TEXT NOT NULL,              -- PBKDF2 盐（hex）
  pwd_hash      TEXT NOT NULL,              -- PBKDF2 派生密钥（hex）
  pwd_iter      INTEGER NOT NULL,           -- 迭代次数
  created_at    INTEGER NOT NULL
);

-- 设备令牌表：每个设备一条，登录一次后长期免密
CREATE TABLE devices (
  token_hash    TEXT PRIMARY KEY,           -- SHA-256(令牌)，明文不落库
  user_id       TEXT NOT NULL,
  label         TEXT,                       -- 设备备注，如“我的手机”
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- 一次性备用码：用掉即标记，不可重用
CREATE TABLE backup_codes (
  code_hash     TEXT PRIMARY KEY,           -- SHA-256(备用码)
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  used_at       INTEGER,                    -- 非空表示已使用
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_codes_user ON backup_codes(user_id);

-- 同步数据：每个用户一条 JSON 记录（作业清单 + 计时记录）
CREATE TABLE sync_data (
  user_id       TEXT PRIMARY KEY,
  data          TEXT NOT NULL,              -- JSON 字符串
  updated_at    INTEGER NOT NULL,           -- 毫秒时间戳，用于冲突判断
  FOREIGN KEY (user_id) REFERENCES users(id)
);
