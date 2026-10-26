-- Nullable and additive so the previous release continues to read and write runs.
ALTER TABLE "local_agent_runs" ADD COLUMN "terminalError" TEXT;
