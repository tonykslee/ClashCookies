import {
  buildActualAdviceSummary,
  buildCompoAdviceContentLines,
  buildWarAdviceSummary,
  type CompoAdviceMode,
} from "../helper/compoAdviceEngine";
import {
  getCompoActualStateViewLabel,
  type CompoActualStateView,
} from "../helper/compoActualStateView";
import { normalizeTag } from "./war-events/core";
import {
  CompoActualStateService,
  loadCompoActualStateContext,
} from "./CompoActualStateService";
import {
  CompoWarStateService,
  loadCompoWarStateContext,
} from "./CompoWarStateService";

export type CompoAdviceReadResult = {
  content: string;
  trackedClanTags: string[];
  selectedView: CompoActualStateView;
  mode: CompoAdviceMode;
};

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function buildNoTrackedClansContent(input: {
  mode: CompoAdviceMode;
  view: CompoActualStateView;
}): string {
  const lines = [
    buildPersistedRefreshLine(null),
    `Mode: **${input.mode.toUpperCase()}**`,
    `Advice View: **${getCompoActualStateViewLabel(input.view)}**`,
    `No tracked clans are configured for DB-backed ${input.mode.toUpperCase()} advice.`,
  ];
  return lines.join("\n");
}

function buildNoTargetContent(input: {
  mode: CompoAdviceMode;
  view: CompoActualStateView;
  targetTag: string;
  knownTags: string[];
}): string {
  const lines = [
    `Mode: **${input.mode.toUpperCase()}**`,
    `Advice View: **${getCompoActualStateViewLabel(input.view)}**`,
    `No tracked clan matched tag \`#${input.targetTag}\`.`,
  ];
  if (input.knownTags.length > 0) {
    lines.push(`Known tags in this mode: ${input.knownTags.map((tag) => `#${tag}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** Purpose: build DB-backed composition advice from persisted ACTUAL and WAR state snapshots only. */
export class CompoAdviceService {
  private readonly actualStateService = new CompoActualStateService();
  private readonly warStateService = new CompoWarStateService();

  async readAdvice(input: {
    guildId?: string | null;
    targetTag: string;
    mode: CompoAdviceMode;
    view?: CompoActualStateView;
  }): Promise<CompoAdviceReadResult> {
    const targetTag = normalizeTag(input.targetTag);
    const view =
      input.mode === "actual" ? input.view ?? "auto" : "raw";

    if (!targetTag) {
      return {
        content: buildNoTargetContent({
          mode: input.mode,
          view,
          targetTag: "",
          knownTags: [],
        }),
        trackedClanTags: [],
        selectedView: view,
        mode: input.mode,
      };
    }

    if (input.mode === "actual") {
      const context = await loadCompoActualStateContext(input.guildId ?? null);
      if (context.trackedClanTags.length === 0) {
        return {
          content: buildNoTrackedClansContent({
            mode: input.mode,
            view,
          }),
          trackedClanTags: [],
          selectedView: view,
          mode: input.mode,
        };
      }

      const clan = context.clans.find((row) => row.clanTag === targetTag);
      if (!clan) {
        return {
          content: buildNoTargetContent({
            mode: input.mode,
            view,
            targetTag,
            knownTags: context.trackedClanTags,
          }),
          trackedClanTags: context.trackedClanTags,
          selectedView: view,
          mode: input.mode,
        };
      }

      const summary = buildActualAdviceSummary({
        base: clan.base,
        heatMapRefs: context.heatMapRefs,
        view,
      });
      const content = buildCompoAdviceContentLines({
        summary,
        modeLabel: input.mode.toUpperCase(),
        refreshLine: buildPersistedRefreshLine(context.latestSourceSyncedAt),
      }).join("\n");
      return {
        content,
        trackedClanTags: context.trackedClanTags,
        selectedView: view,
        mode: input.mode,
      };
    }

    const context = await loadCompoWarStateContext();
    if (context.trackedClanTags.length === 0) {
      return {
        content: buildNoTrackedClansContent({
          mode: input.mode,
          view,
        }),
        trackedClanTags: [],
        selectedView: view,
        mode: input.mode,
      };
    }

    const clan = context.clans.find((row) => row.clanTag === targetTag);
    if (!clan) {
      return {
        content: buildNoTargetContent({
          mode: input.mode,
          view,
          targetTag,
          knownTags: context.trackedClanTags,
        }),
        trackedClanTags: context.trackedClanTags,
        selectedView: view,
        mode: input.mode,
      };
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
    const content = buildCompoAdviceContentLines({
      summary,
      modeLabel: input.mode.toUpperCase(),
      refreshLine: buildPersistedRefreshLine(context.latestRefreshAt),
    }).join("\n");
    return {
      content,
      trackedClanTags: context.trackedClanTags,
      selectedView: view,
      mode: input.mode,
    };
  }

  async refreshAdvice(input: {
    guildId?: string | null;
    targetTag: string;
    mode: CompoAdviceMode;
    view?: CompoActualStateView;
  }): Promise<CompoAdviceReadResult> {
    const view =
      input.mode === "actual" ? input.view ?? "auto" : "raw";

    if (input.mode === "actual") {
      await this.actualStateService.refreshState(input.guildId ?? null, {
        view,
      });
    } else {
      await this.warStateService.refreshState();
    }

    return this.readAdvice(input);
  }
}

export const buildNoTrackedClansContentForTest = buildNoTrackedClansContent;
export const buildNoTargetContentForTest = buildNoTargetContent;
