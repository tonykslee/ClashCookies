import {
  COMPO_ADVICE_VIEW_LABELS,
  buildActualAdviceSummary,
  buildCustomAdviceSummary,
  buildWarAdviceSummary,
  type CompoAdviceMode,
  type CompoAdviceSummary,
  type CompoAdviceView,
} from "../helper/compoAdviceEngine";
import {
  type CompoActualStateView,
} from "../helper/compoActualStateView";
import { HeatMapRefDisplayService } from "./HeatMapRefDisplayService";
import { normalizeTag } from "./war-events/core";
import {
  CompoActualStateService,
  loadCompoActualStateContext,
  type CompoActualStateMemberContext,
} from "./CompoActualStateService";
import {
  CompoWarStateService,
  loadCompoWarStateContext,
} from "./CompoWarStateService";

export type CompoAdviceReadyResult = {
  kind: "ready";
  mode: CompoAdviceMode;
  selectedView: CompoAdviceView;
  trackedClanTags: string[];
  trackedClanChoices: Array<{ tag: string; name: string }>;
  clanTag: string;
  clanName: string;
  summary: CompoAdviceSummary;
  memberCount: number;
  rushedCount: number;
  refreshLine: string | null;
};

export type CompoAdviceEmptyResult = {
  kind: "empty";
  mode: CompoAdviceMode;
  selectedView: CompoAdviceView;
  trackedClanTags: string[];
  trackedClanChoices: Array<{ tag: string; name: string }>;
  clanTag: string | null;
  clanName: string | null;
  message: string;
  refreshLine: string | null;
};

export type CompoAdviceReadResult = CompoAdviceReadyResult | CompoAdviceEmptyResult;

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function buildTrackedClanChoices(input: {
  clans: Array<{ clanTag: string; clanName: string }>;
}): Array<{ tag: string; name: string }> {
  return input.clans.map((clan) => ({
    tag: clan.clanTag,
    name: clan.clanName,
  }));
}

function buildNoTrackedClansMessage(input: {
  mode: CompoAdviceMode;
  view: CompoAdviceView;
}): string {
  return [
    `Mode: **${input.mode.toUpperCase()}**`,
    `Advice View: **${COMPO_ADVICE_VIEW_LABELS[input.view]}**`,
    `No tracked clans are configured for DB-backed ${input.mode.toUpperCase()} advice.`,
  ].join("\n");
}

function buildNoTargetMessage(input: {
  mode: CompoAdviceMode;
  view: CompoAdviceView;
  targetTag: string;
  knownTags: string[];
}): string {
  const lines = [
    `Mode: **${input.mode.toUpperCase()}**`,
    `Advice View: **${COMPO_ADVICE_VIEW_LABELS[input.view]}**`,
    `No tracked clan matched tag \`#${input.targetTag}\`.`,
  ];
  if (input.knownTags.length > 0) {
    lines.push(`Known tags in this mode: ${input.knownTags.map((tag) => `#${tag}`).join(", ")}`);
  }
  return lines.join("\n");
}

const IMPLIES_TOWN_HALL_BY_BUCKET: Record<string, number> = {
  TH18: 18,
  TH17: 17,
  TH16: 16,
  TH15: 15,
  TH14: 14,
  TH13: 13,
  TH12: 12,
  TH11: 11,
  TH10: 10,
  TH9: 9,
  TH8_OR_LOWER: 8,
};

function getActualRefreshView(view: CompoAdviceView): CompoActualStateView {
  if (view === "best") {
    return "best";
  }
  if (view === "raw" || view === "custom") {
    return "raw";
  }
  return "auto";
}

/** Purpose: count rushed ACTUAL members from persisted member rows using the resolved bucket implied Town Hall. */
export function countRushedCompoMembers(
  members: readonly CompoActualStateMemberContext[],
): number {
  let rushed = 0;
  for (const member of members) {
    if (member.townHall === null || member.resolvedBucket === null) {
      continue;
    }
    const impliedTownHall =
      IMPLIES_TOWN_HALL_BY_BUCKET[member.resolvedBucket] ?? null;
    if (impliedTownHall === null) {
      continue;
    }
    if (member.townHall > impliedTownHall) {
      rushed += 1;
    }
  }
  return rushed;
}

function buildReadyResult(input: {
  mode: CompoAdviceMode;
  selectedView: CompoAdviceView;
  trackedClanTags: string[];
  trackedClanChoices: Array<{ tag: string; name: string }>;
  clanTag: string;
  clanName: string;
  summary: CompoAdviceSummary;
  members: readonly CompoActualStateMemberContext[];
  refreshLine: string | null;
}): CompoAdviceReadyResult {
  return {
    kind: "ready",
    mode: input.mode,
    selectedView: input.selectedView,
    trackedClanTags: input.trackedClanTags,
    trackedClanChoices: input.trackedClanChoices,
    clanTag: input.clanTag,
    clanName: input.clanName,
    summary: input.summary,
    memberCount: input.summary.currentProjection.memberCount,
    rushedCount: countRushedCompoMembers(input.members),
    refreshLine: input.refreshLine,
  };
}

function buildEmptyResult(input: {
  mode: CompoAdviceMode;
  selectedView: CompoAdviceView;
  trackedClanTags: string[];
  trackedClanChoices: Array<{ tag: string; name: string }>;
  clanTag: string | null;
  clanName: string | null;
  message: string;
  refreshLine: string | null;
}): CompoAdviceEmptyResult {
  return {
    kind: "empty",
    mode: input.mode,
    selectedView: input.selectedView,
    trackedClanTags: input.trackedClanTags,
    trackedClanChoices: input.trackedClanChoices,
    clanTag: input.clanTag,
    clanName: input.clanName,
    message: input.message,
    refreshLine: input.refreshLine,
  };
}

/** Purpose: build DB-backed composition advice from persisted ACTUAL and WAR state snapshots only. */
export class CompoAdviceService {
  private readonly actualStateService = new CompoActualStateService();
  private readonly warStateService = new CompoWarStateService();
  private readonly heatMapRefDisplayService = new HeatMapRefDisplayService();

  async readAdvice(input: {
    guildId?: string | null;
    targetTag: string;
    mode: CompoAdviceMode;
    view?: CompoAdviceView;
    customBandIndex?: number | null;
  }): Promise<CompoAdviceReadResult> {
    const targetTag = normalizeTag(input.targetTag);
    const view =
      input.mode === "actual" ? input.view ?? "auto" : "raw";

    if (!targetTag) {
      return buildEmptyResult({
        mode: input.mode,
        selectedView: view,
        trackedClanTags: [],
        trackedClanChoices: [],
        clanTag: null,
        clanName: null,
        message: buildNoTargetMessage({
          mode: input.mode,
          view,
          targetTag: "",
          knownTags: [],
        }),
        refreshLine: buildPersistedRefreshLine(null),
      });
    }

    if (input.mode === "actual") {
      const context = await loadCompoActualStateContext(input.guildId ?? null);
      const trackedClanChoices = buildTrackedClanChoices({
        clans: context.clans,
      });
      if (context.trackedClanTags.length === 0) {
        return buildEmptyResult({
          mode: input.mode,
          selectedView: view,
          trackedClanTags: [],
          trackedClanChoices: [],
          clanTag: null,
          clanName: null,
          message: buildNoTrackedClansMessage({
            mode: input.mode,
            view,
          }),
          refreshLine: buildPersistedRefreshLine(null),
        });
      }

      const clan = context.clans.find((row) => row.clanTag === targetTag);
      if (!clan) {
        return buildEmptyResult({
          mode: input.mode,
          selectedView: view,
          trackedClanTags: context.trackedClanTags,
          trackedClanChoices,
          clanTag: null,
          clanName: null,
          message: buildNoTargetMessage({
            mode: input.mode,
            view,
            targetTag,
            knownTags: context.trackedClanTags,
          }),
          refreshLine: buildPersistedRefreshLine(context.latestSourceSyncedAt),
        });
      }

      const summary =
        view === "custom"
          ? buildCustomAdviceSummary({
              base: clan.base,
              heatMapRefs: context.heatMapRefs,
              customBandIndex: input.customBandIndex,
            })
          : buildActualAdviceSummary({
              base: clan.base,
              heatMapRefs: context.heatMapRefs,
              view,
            });
      const bandMatchRatesByBandKey = await this.heatMapRefDisplayService.readHeatMapRefBandMatchRates({
        heatMapRefs: summary.heatMapRefs,
      });
      return buildReadyResult({
        mode: input.mode,
        selectedView: view,
        trackedClanTags: context.trackedClanTags,
        trackedClanChoices,
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        summary: {
          ...summary,
          bandMatchRatesByBandKey,
        },
        members: clan.members,
        refreshLine: buildPersistedRefreshLine(context.latestSourceSyncedAt),
      });
    }

    const context = await loadCompoWarStateContext();
    const trackedClanChoices = buildTrackedClanChoices({
      clans: context.clans,
    });
    if (context.trackedClanTags.length === 0) {
      return buildEmptyResult({
        mode: input.mode,
        selectedView: view,
        trackedClanTags: [],
        trackedClanChoices: [],
        clanTag: null,
        clanName: null,
        message: buildNoTrackedClansMessage({
          mode: input.mode,
          view,
        }),
        refreshLine: buildPersistedRefreshLine(null),
      });
    }

    const clan = context.clans.find((row) => row.clanTag === targetTag);
    if (!clan) {
      return buildEmptyResult({
        mode: input.mode,
        selectedView: view,
        trackedClanTags: context.trackedClanTags,
        trackedClanChoices,
        clanTag: null,
        clanName: null,
        message: buildNoTargetMessage({
          mode: input.mode,
          view,
          targetTag,
          knownTags: context.trackedClanTags,
        }),
        refreshLine: buildPersistedRefreshLine(context.latestRefreshAt),
      });
    }

    const summary = buildWarAdviceSummary({
      base: {
        resolvedTotalWeight: clan.totalEffectiveWeight,
        unresolvedWeightCount: clan.missingWeights,
        memberCount: clan.rosterSize,
        bucketCounts: clan.bucketCounts,
      },
      heatMapRefs: context.heatMapRefs,
    });
    const bandMatchRatesByBandKey = await this.heatMapRefDisplayService.readHeatMapRefBandMatchRates({
      heatMapRefs: summary.heatMapRefs,
    });
    return buildReadyResult({
      mode: input.mode,
      selectedView: view,
      trackedClanTags: context.trackedClanTags,
      trackedClanChoices,
      clanTag: clan.clanTag,
      clanName: clan.clanName,
      summary: {
        ...summary,
        bandMatchRatesByBandKey,
      },
      members: [],
      refreshLine: buildPersistedRefreshLine(context.latestRefreshAt),
    });
  }

  async refreshAdvice(input: {
    guildId?: string | null;
    targetTag: string;
    mode: CompoAdviceMode;
    view?: CompoAdviceView;
    customBandIndex?: number | null;
  }): Promise<CompoAdviceReadResult> {
    const view =
      input.mode === "actual" ? input.view ?? "auto" : "raw";

    if (input.mode === "actual") {
      await this.actualStateService.refreshState(input.guildId ?? null, {
        view: getActualRefreshView(view),
      });
    } else {
      await this.warStateService.refreshState();
    }

    return this.readAdvice(input);
  }
}

export const buildNoTrackedClansContentForTest = buildNoTrackedClansMessage;
export const buildNoTargetContentForTest = buildNoTargetMessage;
