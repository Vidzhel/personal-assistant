-- Stamp the schedule that produced a tree, for run-history + the `scheduled` board badge.
ALTER TABLE task_trees ADD COLUMN schedule_id TEXT;
