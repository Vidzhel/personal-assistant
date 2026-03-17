-- Add source file and URL reference columns to knowledge_index
ALTER TABLE knowledge_index ADD COLUMN source_file TEXT;
ALTER TABLE knowledge_index ADD COLUMN source_url TEXT;
