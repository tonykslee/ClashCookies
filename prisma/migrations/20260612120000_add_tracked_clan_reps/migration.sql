CREATE TABLE "TrackedClanRep" (
    "clanTag" VARCHAR(16) NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,

    CONSTRAINT "TrackedClanRep_pkey" PRIMARY KEY ("clanTag","playerTag"),
    CONSTRAINT "TrackedClanRep_clanTag_fkey" FOREIGN KEY ("clanTag") REFERENCES "TrackedClan"("tag") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TrackedClanRep_playerTag_idx" ON "TrackedClanRep"("playerTag");
