-- Add missing columns to agent_tasks table
ALTER TABLE agent_tasks ADD COLUMN action_name TEXT;
ALTER TABLE agent_tasks ADD COLUMN blocked INTEGER DEFAULT 0;

-- Add indexes for query performance
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_skill_name ON agent_tasks(skill_name);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_completed_at ON agent_tasks(completed_at);
