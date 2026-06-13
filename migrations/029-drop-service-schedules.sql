-- ticktick-task-sync, autonomous-task-management, pattern-analysis, system-maintenance now
-- run as Job-Registry jobs via the unified schedule engine. Remove the legacy DB rows so the
-- legacy Scheduler fires nothing.
DELETE FROM schedules WHERE id IN (
  'ticktick-task-sync',
  'autonomous-task-management',
  'pattern-analysis',
  'system-maintenance'
);
