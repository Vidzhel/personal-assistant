-- Intents: deterministic prospective memory ("remind me when X happens" /
-- "remind me at TIME"). Never LLM-inferred — every row is created by the
-- owner's explicit ask via the create_intent MCP tool (chat scope). See
-- intents/intent-store.ts + intents/intent-matcher.ts.
--
-- Timestamps are epoch ms (INTEGER), not ISO strings, because the guarded
-- fire UPDATE in intent-store.ts does cooldown/expiry arithmetic directly in
-- SQL (now - last_fired_at >= cooldown_hours * 3600000) — integer epoch ms
-- keeps that a plain subtraction instead of a strftime() dance.
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'time')),
  -- JSON array of lowercase keywords — ALL must match (case-insensitive)
  -- against the triggering event's text field for kind='event'. Empty/unused
  -- for kind='time'.
  pattern TEXT NOT NULL DEFAULT '[]',
  -- JSON array of RavenEvent `type` strings this intent listens for
  -- (kind='event' only), e.g. ["email:new"].
  event_types TEXT NOT NULL DEFAULT '[]',
  -- The reminder text delivered to the owner when this intent fires.
  message TEXT NOT NULL,
  -- kind='time' only: epoch ms of the one-shot target fire time, checked by
  -- intent-matcher's minute sweep. NULL for kind='event'.
  next_fire_at INTEGER,
  fire_budget INTEGER NOT NULL DEFAULT 3,
  fires_used INTEGER NOT NULL DEFAULT 0,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  last_fired_at INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'cancelled')),
  created_at INTEGER NOT NULL,
  source_session TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_kind_status ON intents(kind, status);
