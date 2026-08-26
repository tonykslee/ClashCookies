-- Extend the canonical SyncCycle resolution owner for active-war local reconciliation.
ALTER TYPE "SyncCycleResolutionSource" ADD VALUE IF NOT EXISTS 'ACTIVE_WAR_CONFIRMED';
ALTER TYPE "SyncCycleResolutionSource" ADD VALUE IF NOT EXISTS 'ACTIVE_WAR_SCHEDULE_CANONICAL';
