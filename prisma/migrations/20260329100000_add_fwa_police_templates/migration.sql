CREATE TYPE "FwaPoliceViolation" AS ENUM (
  'EARLY_NON_MIRROR_TRIPLE',
  'STRICT_WINDOW_MIRROR_MISS_WIN',
  'STRICT_WINDOW_MIRROR_MISS_LOSS',
  'EARLY_NON_MIRROR_2STAR',
  'ANY_3STAR',
  'LOWER20_ANY_STARS'
);

CREATE TABLE "FwaPoliceClanTemplate" (
  "clanTag" TEXT NOT NULL,
  "violation" "FwaPoliceViolation" NOT NULL,
  "template" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FwaPoliceClanTemplate_pkey" PRIMARY KEY ("clanTag","violation")
);

CREATE TABLE "FwaPoliceDefaultTemplate" (
  "violation" "FwaPoliceViolation" NOT NULL,
  "template" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FwaPoliceDefaultTemplate_pkey" PRIMARY KEY ("violation")
);

CREATE INDEX "FwaPoliceClanTemplate_clanTag_idx" ON "FwaPoliceClanTemplate"("clanTag");
CREATE INDEX "FwaPoliceClanTemplate_violation_idx" ON "FwaPoliceClanTemplate"("violation");
