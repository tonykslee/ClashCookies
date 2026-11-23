import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST,
  NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY,
  type NativeReferenceBandDefinition,
  type NativeReferenceCandidateArtifact,
  type NativeReferenceEraPolicy,
  type NativeReferenceSourceRoster,
} from "../helper/nativeHeatMapRefCandidate";
import { HEAT_MAP_REF_SEED_ROWS } from "./HeatMapRefSeedData";
import { listOpenDeferredWeightRowsByClanAndPlayerTags } from "./WeightInputDefermentService";
import type { OpenWeightInputDefermentMatchRow } from "./WeightInputDefermentService";
import { resolveFwaWeightRows } from "../helper/fwaWeightResolution";

type NativeCandidateDb = Pick<PrismaClient, "fwaTrackedClanWarRosterCurrent">;

/** Purpose: read the persisted tracked-war snapshot without invoking feed, reference, setting, or scheduler owners. */
export class NativeHeatMapRefCandidateService {
  private readonly db: NativeCandidateDb;
  private readonly readDeferredWeights: typeof listOpenDeferredWeightRowsByClanAndPlayerTags;

  constructor(
    db: NativeCandidateDb = prisma,
    readDeferredWeights: typeof listOpenDeferredWeightRowsByClanAndPlayerTags = listOpenDeferredWeightRowsByClanAndPlayerTags,
  ) {
    this.db = db;
    this.readDeferredWeights = readDeferredWeights;
  }

  async readPersistedSourceRosters(input?: {
    defermentScope?: { guildId: string; clanTag: string };
  }): Promise<NativeReferenceSourceRoster[]> {
    const rows = await this.db.fwaTrackedClanWarRosterCurrent.findMany({
      orderBy: { clanTag: "asc" },
      include: {
        members: {
          orderBy: [{ position: "asc" }, { playerTag: "asc" }],
          select: {
            clanTag: true,
            playerTag: true,
            position: true,
            townHall: true,
            rawWeight: true,
            effectiveWeight: true,
            effectiveWeightStatus: true,
          },
        },
      },
    });
    const rosters = rows.map((row) => ({
      clanTag: row.clanTag,
      rosterSize: row.rosterSize,
      totalRawWeight: row.totalRawWeight,
      totalEffectiveWeight: row.totalEffectiveWeight,
      observedAt: row.observedAt,
      sourceUpdatedAt: row.sourceUpdatedAt,
      sourceWarId: row.sourceWarId,
      sourceWarStartTime: row.sourceWarStartTime,
      sourceWarEndTime: row.sourceWarEndTime,
      sourceWarState: row.sourceWarState,
      sourceCurrentWarUpdatedAt: row.sourceCurrentWarUpdatedAt,
      // CurrentWar and WarMembers are separate persisted owners. There is no persisted
      // foreign key proving that these member rows belong to this exact war, so the
      // native contract must remain UNKNOWN rather than infer a binding.
      sourceIdentityStatus: "UNAVAILABLE" as const,
      sourceMatchType: null,
      sourceMemberCompletenessStatus: "UNAVAILABLE" as const,
      members: row.members.map((member) => ({
        clanTag: member.clanTag,
        playerTag: member.playerTag,
        position: member.position,
        townHall: member.townHall,
        rawWeight: member.rawWeight,
        effectiveWeight: member.effectiveWeight,
        effectiveWeightStatus: member.effectiveWeightStatus,
      })),
    }));
    const defermentScope = input?.defermentScope;
    if (!defermentScope?.guildId?.trim() || !defermentScope.clanTag?.trim()) return rosters;
    const roster = rosters.find((candidate) => candidate.clanTag.trim().toUpperCase() === defermentScope.clanTag.trim().toUpperCase());
    if (!roster) return rosters;
    const deferredByClan: Map<string, Map<string, OpenWeightInputDefermentMatchRow>> = await this.readDeferredWeights({
      guildId: defermentScope.guildId,
      clanPlayerTags: [{ clanTag: roster.clanTag, playerTags: roster.members.map((member) => member.playerTag) }],
    });
    const deferredByPlayer = deferredByClan.get(roster.clanTag) ?? deferredByClan.get(roster.clanTag.trim().toUpperCase()) ?? new Map();
    return rosters.map((candidate) => {
      if (candidate.clanTag.trim().toUpperCase() !== roster.clanTag.trim().toUpperCase()) return candidate;
      const members = candidate.members.map((member) => ({
        ...member,
        deferredWeight: deferredByPlayer.get(member.playerTag.trim().toUpperCase())?.deferredWeight ?? null,
      }));
      const resolved = resolveFwaWeightRows(members);
      const totalEffectiveWeight = resolved.every((member) => member.effectiveWeight !== null)
        ? resolved.reduce((sum, member) => sum + (member.effectiveWeight ?? 0), 0)
        : null;
      return {
        ...candidate,
        totalEffectiveWeight,
        members: resolved,
      };
    });
  }

  /** Purpose: generate a candidate artifact from persisted rows and explicit operator policy parameters. */
  async generate(input: {
    evaluationAt: Date | string;
    eraPolicy: NativeReferenceEraPolicy;
    sampleThreshold?: number;
    bandDefinitions?: readonly NativeReferenceBandDefinition[];
    defermentScope?: { guildId: string; clanTag: string };
  }): Promise<NativeReferenceCandidateArtifact> {
    const sourceRosters = await this.readPersistedSourceRosters({ defermentScope: input.defermentScope });
    return generateNativeHeatMapRefCandidate({
      sourceRosters,
      bandDefinitions: input.bandDefinitions ?? HEAT_MAP_REF_SEED_ROWS.map((row) => ({
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
      })),
      eraPolicy: input.eraPolicy,
      evaluationAt: input.evaluationAt,
      sampleThreshold: input.sampleThreshold,
      sourceCategory: NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY,
      evidenceTrust: NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST,
    });
  }
}

