-- morning-digest now fires via the unified schedule engine (template kind). Remove the
-- legacy DB row so the legacy Scheduler no longer fires it (prevents double-firing).
DELETE FROM schedules WHERE id = 'morning-digest';
