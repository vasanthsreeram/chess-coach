-- Schema for a future Chess.com import cache. No import endpoint is enabled yet.
-- Treat public clients as untrusted: do not accept their analysis into a shared cache
-- without server-side verification.
-- Minimal public data: usernames, result codes, end time, time control, UCI moves. No ratings, uuids, clocks, IPs.
CREATE TABLE IF NOT EXISTS chesscom_players (
  username_lc TEXT PRIMARY KEY,           -- lower-case chess.com username (lookup key)
  username    TEXT NOT NULL,              -- display case as published by the API
  first_seen  INTEGER NOT NULL            -- unix seconds
);

CREATE TABLE IF NOT EXISTS chesscom_games (
  game_key      TEXT PRIMARY KEY,         -- 'live:<id>' or 'daily:<id>'
  kind          TEXT NOT NULL CHECK (kind IN ('live', 'daily')),
  game_id       TEXT NOT NULL,
  white         TEXT NOT NULL,            -- display usernames; chesscom_players holds the lower-case index
  black         TEXT NOT NULL,
  white_result  TEXT NOT NULL,
  black_result  TEXT NOT NULL,
  end_time      INTEGER NOT NULL,
  time_class    TEXT NOT NULL,
  time_control  TEXT NOT NULL,
  moves         TEXT NOT NULL,            -- space-separated UCI; finished games are immutable
  moves_sha256  TEXT NOT NULL,
  imported_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chesscom_analysis (
  game_key        TEXT NOT NULL REFERENCES chesscom_games(game_key) ON DELETE CASCADE,
  engine          TEXT NOT NULL,          -- e.g. 'sf19-lite-single|d12|mpv1'
  schema_version  INTEGER NOT NULL,
  moves_sha256    TEXT NOT NULL,          -- must equal chesscom_games.moves_sha256 to be served
  evals           TEXT NOT NULL,          -- JSON array, one validated eval per position (plies + 1)
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (game_key, engine, schema_version)
);
