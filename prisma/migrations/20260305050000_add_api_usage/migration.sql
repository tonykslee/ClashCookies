CREATE TABLE "ApiUsage" (
  "endpoint" TEXT NOT NULL,
  "lastCall" TIMESTAMP(3) NOT NULL,
  "callCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("endpoint")
);
