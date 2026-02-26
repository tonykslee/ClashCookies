import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";

function normalizeTag(input: string | null | undefined): string {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function parseCocTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

type WarMember = {
  tag?: string;
  name?: string;
  mapPosition?: number;
  attacks?: Array<{
    order?: number;
    stars?: number;
    destructionPercentage?: number;
    defenderTag?: string;
  }> | null;
};

export class WarHistoryService {
  constructor(private readonly coc: CoCService) {}

  async observeClanWar(clanTagInput: string): Promise<void> {
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return;

    try {
      const war = await this.coc.getCurrentWar(clanTag);
      if (!war?.clan?.tag || !war?.startTime) return;

      const ownClanTag = normalizeTag(war.clan.tag);
      const ownClanName = String(war.clan.name ?? ownClanTag).trim() || ownClanTag;
      const opponentClanTag = normalizeTag(war.opponent?.tag ?? "");
      const opponentClanName = String(war.opponent?.name ?? opponentClanTag).trim() || opponentClanTag;
      const warStartTime = parseCocTime(war.startTime);
      if (!warStartTime) return;
      const warEndTime = parseCocTime(war.endTime ?? null);
      const warState = String(war.state ?? "").trim() || null;
      const observedAt = new Date();

      const opponentMembers = Array.isArray(war.opponent?.members) ? (war.opponent?.members as WarMember[]) : [];
      const opponentByTag = new Map<string, WarMember>();
      for (const m of opponentMembers) {
        const tag = normalizeTag(m.tag);
        if (tag) opponentByTag.set(tag, m);
      }

      const ownMembers = Array.isArray(war.clan.members) ? (war.clan.members as WarMember[]) : [];
      for (const member of ownMembers) {
        const playerTag = normalizeTag(member.tag);
        if (!playerTag) continue;
        const playerName = String(member.name ?? playerTag).trim() || playerTag;
        const playerPosition =
          Number.isFinite(Number(member.mapPosition)) ? Number(member.mapPosition) : null;
        const attacks = Array.isArray(member.attacks) ? member.attacks : [];
        const sortedAttacks = [...attacks].sort(
          (a, b) => Number(a?.order ?? Number.MAX_SAFE_INTEGER) - Number(b?.order ?? Number.MAX_SAFE_INTEGER)
        );

        await prisma.$executeRaw(
          Prisma.sql`
            INSERT INTO "WarHistoryParticipant"
              ("clanTag","clanName","opponentClanTag","opponentClanName","warStartTime","warEndTime","warState","playerTag","playerName","playerPosition","attacksUsed","createdAt","updatedAt")
            VALUES
              (${ownClanTag}, ${ownClanName}, ${opponentClanTag || null}, ${opponentClanName || null}, ${warStartTime}, ${warEndTime}, ${warState}, ${playerTag}, ${playerName}, ${playerPosition}, ${sortedAttacks.length}, NOW(), NOW())
            ON CONFLICT ("clanTag","warStartTime","playerTag")
            DO UPDATE SET
              "clanName" = EXCLUDED."clanName",
              "opponentClanTag" = EXCLUDED."opponentClanTag",
              "opponentClanName" = EXCLUDED."opponentClanName",
              "warEndTime" = EXCLUDED."warEndTime",
              "warState" = EXCLUDED."warState",
              "playerName" = EXCLUDED."playerName",
              "playerPosition" = EXCLUDED."playerPosition",
              "attacksUsed" = EXCLUDED."attacksUsed",
              "updatedAt" = NOW()
          `
        );

        let attackNum = 0;
        const defenderBestStars = new Map<string, number>();
        for (const attack of sortedAttacks) {
          attackNum += 1;
          const attackOrder = Number(attack?.order ?? attackNum);
          const defenderTag = normalizeTag(attack?.defenderTag ?? "");
          const defender = opponentByTag.get(defenderTag);
          const defenderName = defender ? String(defender.name ?? defenderTag).trim() || defenderTag : null;
          const defenderPosition =
            defender && Number.isFinite(Number(defender.mapPosition))
              ? Number(defender.mapPosition)
              : null;
          const stars = Math.max(0, Number(attack?.stars ?? 0));
          const previousBest = defenderTag ? defenderBestStars.get(defenderTag) ?? 0 : 0;
          const trueStars = Math.max(0, stars - previousBest);
          if (defenderTag) {
            defenderBestStars.set(defenderTag, Math.max(previousBest, stars));
          }
          const destruction = Number(attack?.destructionPercentage ?? 0);

          await prisma.$executeRaw(
            Prisma.sql`
              INSERT INTO "WarHistoryAttack"
                ("clanTag","clanName","opponentClanTag","opponentClanName","warStartTime","warEndTime","warState","playerTag","playerName","playerPosition","attackOrder","attackNumber","defenderTag","defenderName","defenderPosition","stars","trueStars","destruction","attackSeenAt","createdAt","updatedAt")
              VALUES
                (${ownClanTag}, ${ownClanName}, ${opponentClanTag || null}, ${opponentClanName || null}, ${warStartTime}, ${warEndTime}, ${warState}, ${playerTag}, ${playerName}, ${playerPosition}, ${attackOrder}, ${attackNum}, ${defenderTag || null}, ${defenderName}, ${defenderPosition}, ${stars}, ${trueStars}, ${destruction}, ${observedAt}, NOW(), NOW())
              ON CONFLICT ("clanTag","warStartTime","playerTag","attackOrder")
              DO UPDATE SET
                "clanName" = EXCLUDED."clanName",
                "opponentClanTag" = EXCLUDED."opponentClanTag",
                "opponentClanName" = EXCLUDED."opponentClanName",
                "warEndTime" = EXCLUDED."warEndTime",
                "warState" = EXCLUDED."warState",
                "playerName" = EXCLUDED."playerName",
                "playerPosition" = EXCLUDED."playerPosition",
                "attackNumber" = EXCLUDED."attackNumber",
                "defenderTag" = EXCLUDED."defenderTag",
                "defenderName" = EXCLUDED."defenderName",
                "defenderPosition" = EXCLUDED."defenderPosition",
                "stars" = EXCLUDED."stars",
                "trueStars" = EXCLUDED."trueStars",
                "destruction" = EXCLUDED."destruction",
                "attackSeenAt" = EXCLUDED."attackSeenAt",
                "updatedAt" = NOW()
            `
          );
        }
      }
    } catch (err) {
      console.error(`war-history observe failed clan=${clanTag} error=${formatError(err)}`);
    }
  }
}
