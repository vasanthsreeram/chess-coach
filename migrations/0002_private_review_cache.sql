-- Per-browser review cache. Rows are partitioned by owner_hash = SHA-256("chess-review-cache-v2:" || secret);
-- the secret itself never reaches the database. No public/shared analysis table exists: an earlier prototype
-- legacy table (chesscom_analysis) is not read by this code.
CREATE TABLE IF NOT EXISTS review_cache_private (
  owner_hash      TEXT NOT NULL CHECK (length(owner_hash) = 64),
  game_key        TEXT NOT NULL REFERENCES chesscom_games(game_key) ON DELETE CASCADE,
  engine          TEXT NOT NULL,          -- e.g. 'sf19-lite-single|d12|t600|mpv1'
  schema_version  INTEGER NOT NULL,       -- 2
  moves_sha256    TEXT NOT NULL,          -- must equal chesscom_games.moves_sha256 to be served
  evals           TEXT NOT NULL,          -- JSON, plies+1 validated evals
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, game_key, engine, schema_version)
);
