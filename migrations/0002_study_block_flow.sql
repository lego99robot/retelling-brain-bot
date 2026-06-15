ALTER TABLE telegram_drafts ADD COLUMN selected_folder_id TEXT;
ALTER TABLE telegram_drafts ADD COLUMN selected_topic_id TEXT;
ALTER TABLE telegram_drafts ADD COLUMN pending_step TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE telegram_drafts ADD COLUMN note_type TEXT;
