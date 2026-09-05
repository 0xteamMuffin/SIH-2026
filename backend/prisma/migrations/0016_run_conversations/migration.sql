-- Groups a workspace's runs into conversations.
--
-- Each run previously stood alone, so a follow-up message could not see what
-- had already been asked or answered. A conversation id supplied by the client
-- links the turns of one thread, and the agent loads the recent ones as
-- context before it plans.
--
-- Nullable so existing runs, and any caller that does not send one, keep
-- working as isolated single-turn runs.
ALTER TABLE "agent_runs"
ADD COLUMN "conversation_id" UUID;

-- Loading a thread's recent turns is the hot path: filter by conversation
-- within a workspace, newest first.
CREATE INDEX "agent_runs_workspace_id_conversation_id_created_at_idx"
ON "agent_runs" ("workspace_id", "conversation_id", "created_at" DESC);
