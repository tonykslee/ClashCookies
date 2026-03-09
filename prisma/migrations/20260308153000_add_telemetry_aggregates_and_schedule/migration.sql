CREATE TABLE IF NOT EXISTS "TelemetryCommandAggregate" (
  "id" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "guildId" TEXT NOT NULL,
  "commandName" TEXT NOT NULL,
  "subcommand" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "timeoutCount" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
  "minDurationMs" INTEGER,
  "latencyLt250" INTEGER NOT NULL DEFAULT 0,
  "latencyLt1000" INTEGER NOT NULL DEFAULT 0,
  "latencyLt3000" INTEGER NOT NULL DEFAULT 0,
  "latencyLt10000" INTEGER NOT NULL DEFAULT 0,
  "latencyGte10000" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryCommandAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryCommandAggregate_bucketStart_guildId_commandName_subcommand_status_key"
  ON "TelemetryCommandAggregate" ("bucketStart", "guildId", "commandName", "subcommand", "status");
CREATE INDEX IF NOT EXISTS "TelemetryCommandAggregate_guildId_bucketStart_idx"
  ON "TelemetryCommandAggregate" ("guildId", "bucketStart");
CREATE INDEX IF NOT EXISTS "TelemetryCommandAggregate_commandName_bucketStart_idx"
  ON "TelemetryCommandAggregate" ("commandName", "bucketStart");

CREATE TABLE IF NOT EXISTS "TelemetryUserCommandAggregate" (
  "id" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "guildId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "commandName" TEXT NOT NULL,
  "subcommand" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "timeoutCount" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryUserCommandAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryUserCommandAggregate_bucketStart_guildId_userId_commandName_subcommand_key"
  ON "TelemetryUserCommandAggregate" ("bucketStart", "guildId", "userId", "commandName", "subcommand");
CREATE INDEX IF NOT EXISTS "TelemetryUserCommandAggregate_guildId_bucketStart_idx"
  ON "TelemetryUserCommandAggregate" ("guildId", "bucketStart");
CREATE INDEX IF NOT EXISTS "TelemetryUserCommandAggregate_guildId_userId_bucketStart_idx"
  ON "TelemetryUserCommandAggregate" ("guildId", "userId", "bucketStart");

CREATE TABLE IF NOT EXISTS "TelemetryApiAggregate" (
  "id" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "guildId" TEXT NOT NULL,
  "commandName" TEXT NOT NULL DEFAULT '',
  "namespace" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "errorCategory" TEXT NOT NULL DEFAULT '',
  "errorCode" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "timeoutCount" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryApiAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryApiAggregate_bucketStart_guildId_commandName_namespace_operation_source_status_errorCategory_errorCode_key"
  ON "TelemetryApiAggregate" ("bucketStart", "guildId", "commandName", "namespace", "operation", "source", "status", "errorCategory", "errorCode");
CREATE INDEX IF NOT EXISTS "TelemetryApiAggregate_guildId_bucketStart_idx"
  ON "TelemetryApiAggregate" ("guildId", "bucketStart");
CREATE INDEX IF NOT EXISTS "TelemetryApiAggregate_namespace_operation_bucketStart_idx"
  ON "TelemetryApiAggregate" ("namespace", "operation", "bucketStart");

CREATE TABLE IF NOT EXISTS "TelemetryStageAggregate" (
  "id" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "guildId" TEXT NOT NULL,
  "commandName" TEXT NOT NULL,
  "subcommand" TEXT NOT NULL DEFAULT '',
  "stage" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryStageAggregate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryStageAggregate_bucketStart_guildId_commandName_subcommand_stage_status_key"
  ON "TelemetryStageAggregate" ("bucketStart", "guildId", "commandName", "subcommand", "stage", "status");
CREATE INDEX IF NOT EXISTS "TelemetryStageAggregate_guildId_bucketStart_idx"
  ON "TelemetryStageAggregate" ("guildId", "bucketStart");
CREATE INDEX IF NOT EXISTS "TelemetryStageAggregate_commandName_stage_bucketStart_idx"
  ON "TelemetryStageAggregate" ("commandName", "stage", "bucketStart");

CREATE TABLE IF NOT EXISTS "TelemetryReportSchedule" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "cadenceHours" INTEGER NOT NULL DEFAULT 24,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastPostedWindowStart" TIMESTAMP(3),
  "lastPostedWindowEnd" TIMESTAMP(3),
  "lastPostedAt" TIMESTAMP(3),
  "lastMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryReportSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryReportSchedule_guildId_key"
  ON "TelemetryReportSchedule" ("guildId");
CREATE INDEX IF NOT EXISTS "TelemetryReportSchedule_enabled_updatedAt_idx"
  ON "TelemetryReportSchedule" ("enabled", "updatedAt");

CREATE TABLE IF NOT EXISTS "TelemetryReportRun" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "cadenceHours" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "messageId" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "postedAt" TIMESTAMP(3),
  CONSTRAINT "TelemetryReportRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryReportRun_guildId_windowStart_windowEnd_key"
  ON "TelemetryReportRun" ("guildId", "windowStart", "windowEnd");
CREATE INDEX IF NOT EXISTS "TelemetryReportRun_guildId_status_createdAt_idx"
  ON "TelemetryReportRun" ("guildId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "TelemetryReportRun_status_createdAt_idx"
  ON "TelemetryReportRun" ("status", "createdAt");
