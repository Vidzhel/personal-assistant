-- Adds channel column to notification_queue for databases created before
-- migration 009 included this column. No-op for newer databases.
-- The migration runner will handle the duplicate column error gracefully.
ALTER TABLE notification_queue ADD COLUMN channel TEXT;
