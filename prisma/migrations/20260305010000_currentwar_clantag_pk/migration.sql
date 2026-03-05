-- Switch CurrentWar primary key from surrogate id to clanTag+guildId
ALTER TABLE "CurrentWar" DROP CONSTRAINT "CurrentWar_pkey";
ALTER TABLE "CurrentWar" DROP COLUMN "id";
ALTER TABLE "CurrentWar" ADD CONSTRAINT "CurrentWar_pkey" PRIMARY KEY ("clanTag","guildId");
