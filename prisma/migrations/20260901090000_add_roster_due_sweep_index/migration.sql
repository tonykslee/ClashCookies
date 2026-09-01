-- Supports the production roster lifecycle sweep by lifecycle state and deadline.
CREATE INDEX "Roster_lifecycleState_endsAt_idx" ON "Roster"("lifecycleState", "endsAt");
