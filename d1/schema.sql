-- RINACE D1 schema
-- 与 `_audit/build_d1_seed.py` 生成的 seed.sql 配套。
-- 重新导入时先执行 `DROP TABLE IF EXISTS ...`（seed.sql 里已包含）。

DROP TABLE IF EXISTS meta;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

DROP TABLE IF EXISTS leagues;
CREATE TABLE leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short TEXT,
  path TEXT
);

DROP TABLE IF EXISTS seasons;
CREATE TABLE seasons (
  key TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  division TEXT NOT NULL DEFAULT 'main',
  season TEXT NOT NULL,
  name TEXT,
  division_name TEXT,
  path TEXT,
  standings_path TEXT,
  source TEXT,
  driver_count INTEGER,
  round_count INTEGER,
  leader_name TEXT,
  leader_points REAL
);
CREATE INDEX idx_seasons_league ON seasons(league, division, season);

DROP TABLE IF EXISTS season_drivers;
CREATE TABLE season_drivers (
  season_key TEXT NOT NULL,
  rank INTEGER,
  driver_id TEXT,
  name TEXT NOT NULL,
  points REAL,
  starts INTEGER,
  wins INTEGER,
  podiums INTEGER,
  per_round TEXT,
  PRIMARY KEY (season_key, name)
);
CREATE INDEX idx_sd_driver ON season_drivers(driver_id);
CREATE INDEX idx_sd_season_rank ON season_drivers(season_key, rank);

DROP TABLE IF EXISTS races;
CREATE TABLE races (
  slug TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  division TEXT NOT NULL DEFAULT 'main',
  season TEXT NOT NULL,
  round INTEGER,
  date TEXT,
  time TEXT,
  track TEXT,
  track_id TEXT,
  session_label TEXT,
  winner TEXT,
  field_size INTEGER,
  laps INTEGER,
  scoring INTEGER,
  result_only INTEGER,
  has_analysis INTEGER,
  has_official INTEGER,
  path TEXT
);
CREATE INDEX idx_races_league ON races(league, division, season, round);
CREATE INDEX idx_races_date ON races(date DESC);

DROP TABLE IF EXISTS race_results;
CREATE TABLE race_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_slug TEXT NOT NULL,
  pos INTEGER,
  driver_id TEXT,
  name TEXT NOT NULL,
  team TEXT,
  grid INTEGER,
  status TEXT,
  dnf INTEGER,
  points REAL,
  best TEXT,
  source TEXT
);
CREATE INDEX idx_rr_race ON race_results(race_slug, pos);
CREATE INDEX idx_rr_driver ON race_results(driver_id);

DROP TABLE IF EXISTS drivers;
CREATE TABLE drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT
);
CREATE INDEX idx_drivers_name ON drivers(name);

DROP TABLE IF EXISTS ratings;
CREATE TABLE ratings (
  regime TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_label TEXT,
  driver_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rating REAL,
  rating_adj REAL,
  races INTEGER,
  perf_mode TEXT,
  low_sample INTEGER,
  dims TEXT,
  league TEXT,
  PRIMARY KEY (regime, scope_key, driver_id)
);
CREATE INDEX idx_ratings_scope ON ratings(scope_key, regime, rating DESC);
CREATE INDEX idx_ratings_driver ON ratings(driver_id);

DROP TABLE IF EXISTS calendar;
CREATE TABLE calendar (
  id TEXT PRIMARY KEY,
  league TEXT,
  league_name TEXT,
  division TEXT,
  division_name TEXT,
  season TEXT,
  round INTEGER,
  track TEXT,
  track_id TEXT,
  date TEXT,
  time TEXT,
  status TEXT,
  race_path TEXT
);
CREATE INDEX idx_cal_date ON calendar(date);
CREATE INDEX idx_cal_status ON calendar(status);

DROP TABLE IF EXISTS tracks;
CREATE TABLE tracks (
  track_id TEXT PRIMARY KEY,
  name TEXT,
  en TEXT,
  races_count INTEGER,
  analysed_count INTEGER,
  archetype TEXT,
  path TEXT
);

DROP TABLE IF EXISTS penalties;
CREATE TABLE penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  league TEXT,
  season TEXT,
  round INTEGER,
  driver TEXT,
  driver_id TEXT,
  type TEXT,
  reason TEXT,
  points REAL,
  handled_by TEXT,
  protest_id TEXT,
  created_at TEXT
);
CREATE INDEX idx_pen_driver ON penalties(driver);
CREATE INDEX idx_pen_ls ON penalties(league, season, round);

DROP TABLE IF EXISTS sync_log;
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  source TEXT,
  detail TEXT,
  ok INTEGER
);
