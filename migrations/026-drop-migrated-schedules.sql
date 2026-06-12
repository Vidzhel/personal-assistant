-- These three schedules are now owned by the unified schedule engine
-- (projects/schedules/*.yaml with run:{kind:job}). Remove the legacy DB rows
-- so the legacy Scheduler no longer fires them (prevents double-firing).
DELETE FROM schedules WHERE id IN (
  'task-archival',
  'knowledge-retrospective',
  'knowledge-consolidation'
);
