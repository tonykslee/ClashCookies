import type { FwaFeedScopeType, FwaFeedSyncStatus, FwaFeedType } from "@prisma/client";

export type FwaClansFeedRow = {
  clanTag: string;
  name: string;
  level: number | null;
  points: number | null;
  type: string | null;
  location: string | null;
  requiredTrophies: number | null;
  warFrequency: string | null;
  winStreak: number | null;
  wins: number | null;
  ties: number | null;
  losses: number | null;
  isWarLogPublic: boolean | null;
  imageUrl: string | null;
  description: string | null;
  th18Count: number | null;
  th17Count: number | null;
  th16Count: number | null;
  th15Count: number | null;
  th14Count: number | null;
  th13Count: number | null;
  th12Count: number | null;
  th11Count: number | null;
  th10Count: number | null;
  th9Count: number | null;
  th8Count: number | null;
  thLowCount: number | null;
  estimatedWeight: number | null;
};

export type FwaClanMemberFeedRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  role: string | null;
  level: number | null;
  donated: number | null;
  received: number | null;
  rank: number | null;
  trophies: number | null;
  league: string | null;
  townHall: number | null;
  weight: number | null;
  inWar: boolean | null;
};

export type FwaWarMemberFeedRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  position: number | null;
  townHall: number | null;
  weight: number | null;
  opponentTag: string | null;
  opponentName: string | null;
  attacks: number | null;
  defender1Tag: string | null;
  defender1Name: string | null;
  defender1TownHall: number | null;
  defender1Position: number | null;
  stars1: number | null;
  destructionPercentage1: number | null;
  defender2Tag: string | null;
  defender2Name: string | null;
  defender2TownHall: number | null;
  defender2Position: number | null;
  stars2: number | null;
  destructionPercentage2: number | null;
};

export type FwaClanWarsFeedRow = {
  clanTag: string;
  endTime: Date;
  searchTime: Date | null;
  result: string | null;
  teamSize: number;
  clanName: string | null;
  clanLevel: number | null;
  clanStars: number | null;
  clanDestructionPercentage: number | null;
  clanAttacks: number | null;
  clanExpEarned: number | null;
  opponentTag: string;
  opponentName: string | null;
  opponentLevel: number | null;
  opponentStars: number | null;
  opponentDestructionPercentage: number | null;
  opponentInfo: string | null;
  synced: boolean | null;
  matched: boolean | null;
};

export type FwaFeedScope = {
  feedType: FwaFeedType;
  scopeType: FwaFeedScopeType;
  scopeKey: string | null;
};

export type FwaSyncResult = {
  rowCount: number;
  changedRowCount: number;
  contentHash: string | null;
  status: FwaFeedSyncStatus;
};

export type FwaTrackedWarsWatchDecision = {
  pollingActive: boolean;
  nextSyncTimeAt: Date | null;
  pollWindowStartAt: Date | null;
  currentWarCycleKey: string | null;
  stopReason: string | null;
};
