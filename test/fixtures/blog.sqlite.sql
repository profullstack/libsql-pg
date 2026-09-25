PRAGMA foreign_keys = ON;
BEGIN;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen INTEGER DEFAULT (strftime('%s','now')),
  api_key TEXT DEFAULT (lower(hex(randomblob(16)))),
  settings JSON
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  score REAL DEFAULT 0.0,
  cover BLOB,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  published_at TIMESTAMP,
  "order" INTEGER,
  UNIQUE (user_id, slug)
) WITHOUT ROWID;
CREATE TABLE tags (
  post_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (post_id, tag),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0 ON CONFLICT REPLACE
) STRICT;
CREATE TABLE seq_style (
  id INTEGER NOT NULL,
  label TEXT,
  PRIMARY KEY (id AUTOINCREMENT)
);
CREATE INDEX IF NOT EXISTS posts_user_idx ON posts (user_id, published_at DESC);
CREATE UNIQUE INDEX users_name_idx ON users (name COLLATE NOCASE);
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, slug UNINDEXED, content='posts', content_rowid='id');
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER posts_touch AFTER UPDATE ON posts BEGIN
  UPDATE posts SET published_at = CASE WHEN new.published = 1 THEN datetime('now') ELSE NULL END WHERE id = new.id;
END;
CREATE VIEW recent_posts AS SELECT id, title FROM posts WHERE created_at > datetime('now', '-7 days');
ALTER TABLE users ADD COLUMN bio TEXT DEFAULT '';
INSERT OR IGNORE INTO counters (key, value) VALUES ('visits', 0);
DELETE FROM sqlite_sequence WHERE name = 'users';
COMMIT;
