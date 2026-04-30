-- Add roster-level signup role gating and allowance tracking.
ALTER TABLE "Roster"
ADD COLUMN "requiredSignupRoleId" TEXT,
ADD COLUMN "noRoleSignupLimit" INTEGER NOT NULL DEFAULT 0;
