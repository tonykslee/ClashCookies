import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoRefreshCustomIdForTest,
  handleCompoRefreshButton,
} from "../src/commands/Compo";
import { CompoActualStateService } from "../src/services/CompoActualStateService";

function makeMessageRow(customId: string, label: string, disabled = false): { toJSON: () => unknown } {
  return {
    toJSON: () => ({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label,
          custom_id: customId,
          disabled,
        },
      ],
    }),
  };
}

function readFirstButton(payload: unknown): { label: string; disabled: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  const firstRow = rows[0];
  const normalized =
    firstRow && typeof (firstRow as { toJSON?: () => unknown }).toJSON === "function"
      ? (firstRow as { toJSON: () => unknown }).toJSON()
      : firstRow;
  if (!normalized || typeof normalized !== "object") return null;
  const firstComponent = Array.isArray((normalized as { components?: unknown[] }).components)
    ? (normalized as { components: unknown[] }).components[0]
    : null;
  if (!firstComponent || typeof firstComponent !== "object") return null;
  return {
    label: String((firstComponent as { label?: unknown }).label ?? ""),
    disabled: Boolean((firstComponent as { disabled?: unknown }).disabled),
  };
}

function makeInteraction(customId: string) {
  const interaction: any = {
    customId,
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    message: {
      id: "message-1",
      components: [
        makeMessageRow(customId, "Refresh Data"),
        makeMessageRow("post-channel:user-1", "Post to Channel"),
      ],
    },
    replied: false,
    deferred: false,
    update: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

describe("compo refresh button behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading state, refreshes DB-backed ACTUAL state, and rerenders state output", async () => {
    vi.spyOn(CompoActualStateService.prototype, "refreshState").mockResolvedValue({
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ["ACTUAL CLAN", "1,500,000", "2", "50", "0", "-1", "0", "0", "0", "0"],
      ],
      contentLines: ["RAW Data last refreshed: <t:1709900000:F>"],
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
    });

    const customId = buildCompoRefreshCustomIdForTest({
      kind: "state",
      userId: "user-1",
      mode: "actual",
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    expect(CompoActualStateService.prototype.refreshState).toHaveBeenCalledWith(
      "guild-1",
    );
    const loadingPayload = interaction.update.mock.calls[0]?.[0];
    expect(readFirstButton(loadingPayload)).toEqual({
      label: "Refreshing...",
      disabled: true,
    });
    const refreshedPayload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(readFirstButton(refreshedPayload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
    expect(Array.isArray(refreshedPayload.files)).toBe(true);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("restores non-loading state and keeps previous output on DB-backed ACTUAL refresh failure", async () => {
    vi.spyOn(CompoActualStateService.prototype, "refreshState").mockRejectedValue(
      new Error("boom"),
    );
    const customId = buildCompoRefreshCustomIdForTest({
      kind: "state",
      userId: "user-1",
      mode: "actual",
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    const loadingPayload = interaction.update.mock.calls[0]?.[0];
    expect(readFirstButton(loadingPayload)).toEqual({
      label: "Refreshing...",
      disabled: true,
    });
    const recoveryPayload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(readFirstButton(recoveryPayload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "content")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "embeds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "files")).toBe(false);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(String(interaction.followUp.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Failed to refresh DB-backed ACTUAL state."
    );
  });
});
