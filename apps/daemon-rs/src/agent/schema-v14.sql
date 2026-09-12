-- Stage 8 (Electron 接入): image attachments on structured agent messages.
--
-- Busy-turn queued messages must keep their image bytes until the drain, so
-- the queue row carries the same attachment array the HTTP send accepted
-- (JSON: [{mimeType,dataB64,name?}]). The timeline only stores refs.
ALTER TABLE agent_message_queue ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
