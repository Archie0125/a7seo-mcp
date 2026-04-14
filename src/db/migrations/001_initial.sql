CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  language TEXT DEFAULT 'zh-TW',
  region TEXT DEFAULT 'TW',
  publisher_adapter TEXT DEFAULT 'markdown-files',
  publisher_config TEXT,
  keyword_provider TEXT DEFAULT 'google-trends',
  rank_provider TEXT DEFAULT 'google-search',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  keyword TEXT NOT NULL,
  volume INTEGER,
  volume_source TEXT,
  volume_confidence TEXT DEFAULT 'estimated',
  difficulty REAL,
  cpc REAL,
  intent TEXT,
  cluster_id INTEGER,
  trend TEXT,
  trend_interest INTEGER,
  source TEXT,
  verified_by_dataforseo INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_keywords_project ON keywords(project_id);
CREATE INDEX IF NOT EXISTS idx_keywords_cluster ON keywords(project_id, cluster_id);

CREATE TABLE IF NOT EXISTS keyword_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  primary_keyword TEXT,
  intent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_keyword_id INTEGER REFERENCES keywords(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  content_html TEXT,
  schema_json TEXT,
  meta_description TEXT,
  word_count INTEGER,
  published_url TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_articles_project_status ON articles(project_id, status);

CREATE TABLE IF NOT EXISTS rank_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  keyword_id INTEGER NOT NULL REFERENCES keywords(id),
  position INTEGER,
  url TEXT,
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rank_history_lookup
  ON rank_history(project_id, keyword_id, checked_at);

CREATE TABLE IF NOT EXISTS optimization_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  article_id INTEGER REFERENCES articles(id),
  action TEXT NOT NULL,
  reason TEXT,
  before_snapshot TEXT,
  after_snapshot TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  keyword_id INTEGER REFERENCES keywords(id),
  planned_date TEXT,
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'planned',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cache table for rate-limited providers
CREATE TABLE IF NOT EXISTS provider_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  UNIQUE(provider, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_cache_lookup ON provider_cache(provider, cache_key, expires_at);
