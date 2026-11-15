-- A rowid watermark avoids losing unread messages when read/send timestamps tie.
ALTER TABLE conversation_members
  ADD COLUMN last_read_message_rowid INTEGER NOT NULL DEFAULT 0;

-- Preserve the last-read state of existing users when upgrading the schema.
UPDATE conversation_members
SET last_read_message_rowid = COALESCE((
  SELECT MAX(message.rowid)
  FROM messages message
  WHERE message.conversation_id = conversation_members.conversation_id
    AND message.sent_at <= COALESCE(conversation_members.last_read_at, '')
), 0);
