CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(folder_id, name)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL CHECK(author_role IN ('owner', 'teacher')),
  content TEXT NOT NULL CHECK(length(content) <= 1000),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teacher_comments (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('topic', 'note', 'photo')),
  target_id TEXT,
  author_role TEXT NOT NULL CHECK(author_role IN ('owner', 'teacher')),
  content TEXT NOT NULL CHECK(length(content) <= 1000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_drafts (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text', 'photo')),
  text_content TEXT,
  telegram_file_id TEXT,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_usage (
  usage_date TEXT NOT NULL,
  user_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_date, user_key)
);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_topics_folder ON topics(folder_id);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_photos_topic ON photos(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_topic ON teacher_comments(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON telegram_drafts(telegram_user_id, created_at);
