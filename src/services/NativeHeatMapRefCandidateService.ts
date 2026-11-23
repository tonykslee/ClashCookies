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
    evaluationAt?: Date | string;
    eraStartIso?: string;
    eraEndIso?: string;
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
    // The lookup is intentionally open-row state, not a historical snapshot. Only a
    // deferment that existed at evaluation time and inside the selected era may affect
    // this diagnostic; future-created rows must remain invisible to earlier evaluations.
    const evaluationMs = input?.evaluationAt instanceof Date
      ? input.evaluationAt.getTime()
      : typeof input?.evaluationAt === "string"
        ? new Date(input.evaluationAt).getTime()
        : Number.NaN;
    const eraStartMs = input?.eraStartIso ? new Date(input.eraStartIso).getTime() : Number.NEGATIVE_INFINITY;
    const eraEndMs = input?.eraEndIso ? new Date(input.eraEndIso).getTime() : Number.POSITIVE_INFINITY;
    const eligibleDeferred = (member: NativeReferenceSourceRoster["members"][number]) => {
      const row = deferredByPlayer.get(member.playerTag.trim().toUpperCase());
      if (!row || !Number.isFinite(evaluationMs)) return null;
      const createdAtMs = row.createdAt?.getTime?.() ?? Number.NaN;
      if (!Number.isFinite(createdAtMs) || createdAtMs < eraStartMs || createdAtMs > eraEndMs || createdAtMs > evaluationMs) return null;
      return row;
    };
    return rosters.map((candidate) => {
      if (candidate.clanTag.trim().toUpperCase() !== roster.clanTag.trim().toUpperCase()) return candidate;
      const members = candidate.members.map((member) => ({
        ...member,
        deferredWeight: eligibleDeferred(member)?.deferredWeight ?? null,
        deferredCreatedAt: eligibleDeferred(member)?.createdAt ?? null,
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
    const sourceRosters = await this.readPersistedSourceRosters({
      defermentScope: input.defermentScope,
      evaluationAt: input.evaluationAt,
      eraStartIso: input.eraPolicy.eraStartIso,
      eraEndIso: input.eraPolicy.eraEndIso,
    });
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

