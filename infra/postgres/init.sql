CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS game_time (
  id INT PRIMARY KEY,
  year INT NOT NULL,
  month INT NOT NULL,
  day INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  name_kr TEXT NOT NULL,
  city_type TEXT NOT NULL DEFAULT 'City',
  region TEXT NOT NULL DEFAULT '',
  coordinates POINT,
  resources JSONB NOT NULL DEFAULT '{}'::jsonb,
  gold INT NOT NULL DEFAULT 10000,
  rice INT NOT NULL DEFAULT 50000,
  population INT NOT NULL DEFAULT 100000,
  commerce INT NOT NULL DEFAULT 100,
  farming INT NOT NULL DEFAULT 100,
  defense INT NOT NULL DEFAULT 100,
  security INT NOT NULL DEFAULT 50,
  defense_max INT NOT NULL DEFAULT 1000,
  owner_force_id TEXT NOT NULL DEFAULT 'neutral'
);

CREATE TABLE IF NOT EXISTS officers (
  id TEXT PRIMARY KEY,
  name_kr TEXT NOT NULL,
  family_name TEXT NOT NULL DEFAULT '',
  given_name TEXT NOT NULL DEFAULT '',
  style_name TEXT NOT NULL DEFAULT '',
  war INT NOT NULL,
  int_stat INT NOT NULL,
  pol INT NOT NULL,
  chr INT NOT NULL,
  ldr INT NOT NULL,
  ap INT NOT NULL DEFAULT 100,
  merit INT NOT NULL DEFAULT 0,
  fame INT NOT NULL DEFAULT 0,
  gold INT NOT NULL DEFAULT 500,
  loyalty INT NOT NULL DEFAULT 70,
  compatibility INT NOT NULL DEFAULT 75,
  personality TEXT NOT NULL DEFAULT '',
  hidden_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_playable BOOLEAN NOT NULL DEFAULT FALSE,
  is_historical BOOLEAN NOT NULL DEFAULT FALSE,
  rank INT NOT NULL DEFAULT 9,
  force_id TEXT NOT NULL DEFAULT 'ronin',
  city_id TEXT NOT NULL REFERENCES cities(id),
  status TEXT NOT NULL DEFAULT 'idle'
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_user_id TEXT UNIQUE,
  username TEXT NOT NULL,
  officer_id TEXT NOT NULL REFERENCES officers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS command_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key TEXT UNIQUE,
  player_id UUID NOT NULL REFERENCES players(id),
  command_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS biography_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  officer_id TEXT NOT NULL REFERENCES officers(id),
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL,
  narration TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Directed, typed relationships (guanxi)
CREATE TABLE IF NOT EXISTS relationships (
  source_officer_id TEXT NOT NULL REFERENCES officers(id),
  target_officer_id TEXT NOT NULL REFERENCES officers(id),
  rel_type TEXT NOT NULL,
  affinity_score INT NOT NULL DEFAULT 0,
  history_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_officer_id, target_officer_id, rel_type)
);
CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships (source_officer_id);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships (target_officer_id);

-- Scenario events: date + condition_json + effect_script
CREATE TABLE IF NOT EXISTS scenario_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trigger_year INT NOT NULL,
  trigger_month INT NOT NULL,
  trigger_day INT NOT NULL,
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  effect_script JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scenario_events_trigger_idx ON scenario_events (trigger_year, trigger_month, trigger_day);

INSERT INTO game_time (id, year, month, day)
VALUES (1, 190, 1, 1)
ON CONFLICT (id) DO NOTHING;

-- NOTE:
-- World/scenario seed data is owned by the API boot seeder (services/api/src/seeds/world190.js).
-- Keeping init.sql seedless prevents mismatches between scenario variants.

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-battler (1v1) schema (new mode; does not replace the MUD loop tables)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT '1v1',
  status TEXT NOT NULL DEFAULT 'lobby',
  seed BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat INT NOT NULL,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES officers(id),
  hp INT NOT NULL DEFAULT 100,
  gold INT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 1,
  xp INT NOT NULL DEFAULT 0,
  board_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  bench_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  effects JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX IF NOT EXISTS match_players_match_idx ON match_players (match_id);
CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id);

CREATE TABLE IF NOT EXISTS match_rounds (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round INT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'prep',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (match_id, round)
);
CREATE INDEX IF NOT EXISTS match_rounds_match_idx ON match_rounds (match_id);
