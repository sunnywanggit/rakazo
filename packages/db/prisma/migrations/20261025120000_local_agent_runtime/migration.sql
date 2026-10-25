-- CreateTable
CREATE TABLE "local_agent_connections" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_agent_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_agent_targets" (
    "revision" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',

    CONSTRAINT "local_agent_targets_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "local_agent_sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "generation" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "local_agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_agent_runs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "output" TEXT NOT NULL DEFAULT '',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "hostFence" INTEGER NOT NULL DEFAULT 0,
    "terminalStatus" TEXT,

    CONSTRAINT "local_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_agent_interactions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "decision" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_agent_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "local_agent_connections_spaceId_userId_idx" ON "local_agent_connections"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "local_agent_targets_spaceId_userId_idx" ON "local_agent_targets"("spaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "local_agent_session_scope" ON "local_agent_sessions"("spaceId", "userId", "botId", "threadId", "connectionId", "projectId", "model", "access", "generation");

-- CreateIndex
CREATE INDEX "local_agent_runs_spaceId_userId_idx" ON "local_agent_runs"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "local_agent_interactions_spaceId_userId_runId_status_idx" ON "local_agent_interactions"("spaceId", "userId", "runId", "status");

-- AddForeignKey
ALTER TABLE "local_agent_connections" ADD CONSTRAINT "local_agent_connections_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_connections" ADD CONSTRAINT "local_agent_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_connections" ADD CONSTRAINT "local_agent_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_targets" ADD CONSTRAINT "local_agent_targets_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_targets" ADD CONSTRAINT "local_agent_targets_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_targets" ADD CONSTRAINT "local_agent_targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_targets" ADD CONSTRAINT "local_agent_targets_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "local_agent_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_sessions" ADD CONSTRAINT "local_agent_sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_sessions" ADD CONSTRAINT "local_agent_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_sessions" ADD CONSTRAINT "local_agent_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_sessions" ADD CONSTRAINT "local_agent_sessions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_sessions" ADD CONSTRAINT "local_agent_sessions_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "local_agent_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_id_fkey" FOREIGN KEY ("id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "local_agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_interactions" ADD CONSTRAINT "local_agent_interactions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_interactions" ADD CONSTRAINT "local_agent_interactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_interactions" ADD CONSTRAINT "local_agent_interactions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_agent_interactions" ADD CONSTRAINT "local_agent_interactions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "local_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "local_agent_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_agent_connections_tenant ON "local_agent_connections" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY local_agent_connections_system ON "local_agent_connections" USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "local_agent_targets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_agent_targets_tenant ON "local_agent_targets" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY local_agent_targets_system ON "local_agent_targets" USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "local_agent_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_agent_sessions_tenant ON "local_agent_sessions" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY local_agent_sessions_system ON "local_agent_sessions" USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "local_agent_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_agent_runs_tenant ON "local_agent_runs" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY local_agent_runs_system ON "local_agent_runs" USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "local_agent_interactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_agent_interactions_tenant ON "local_agent_interactions" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY local_agent_interactions_system ON "local_agent_interactions" USING (current_setting('app.rls_bypass', true) = 'on');
