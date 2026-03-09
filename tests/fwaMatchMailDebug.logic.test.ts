import { describe, expect, it } from "vitest";
import {
  buildMailStatusDebugLinesForTest,
  buildWarMailStatusDebugSnapshotForTest,
} from "../src/commands/Fwa";

describe("fwa match mail-status debug snapshot", () => {
  it("maps stored message winner and definitive exists outcome", () => {
    const debug = buildWarMailStatusDebugSnapshotForTest({
      currentWarId: "1001324",
      trackedTarget: {
        channelId: "1234567890",
        messageId: "99887766",
        warId: "1001324",
        source: "war_mail_lifecycle",
      },
      matchesCurrentMailConfig: true,
      status: "posted",
      reconciliationOutcome: "exists",
    });

    expect(debug.winningSource).toBe("WarMailLifecycle");
    expect(debug.trackedMessageExists).toBe("yes");
    expect(debug.reconciliationCertainty).toBe("definitive");
    expect(debug.environmentMismatchSignal).toBe(false);
    expect(debug.finalNormalizedStatus).toBe("posted");
  });

  it("flags war-id mismatch and mismatch diagnosis for stale tracked config", () => {
    const debug = buildWarMailStatusDebugSnapshotForTest({
      currentWarId: "1001329",
      trackedTarget: {
        channelId: "222",
        messageId: "333",
        warId: "1001324",
        source: "war_mail_lifecycle",
      },
      matchesCurrentMailConfig: false,
      status: "not_posted",
      reconciliationOutcome: "not_checked",
    });

    expect(debug.winningSource).toBe("WarMailLifecycle");
    expect(debug.trackedMessageExists).toBe("unknown");
    expect(debug.debugReasonCode).toBe("no_post_tracked");
    expect(debug.environmentMismatchSignal).toBe(true);
  });

  it("maps definitive missing message outcome for stale tracked post", () => {
    const debug = buildWarMailStatusDebugSnapshotForTest({
      currentWarId: "1001324",
      trackedTarget: {
        channelId: "222",
        messageId: "333",
        warId: "1001324",
        source: "war_mail_lifecycle",
      },
      matchesCurrentMailConfig: true,
      status: "deleted",
      reconciliationOutcome: "message_missing_confirmed",
    });

    expect(debug.trackedMessageExists).toBe("no");
    expect(debug.reconciliationCertainty).toBe("definitive");
    expect(debug.debugReasonCode).toBe("tracked_post_missing_message");
    expect(debug.debugReason.toLowerCase()).toContain("missing");
  });
});

describe("fwa match mail-status debug lines", () => {
  it("renders required diagnostics fields", () => {
    const debug = buildWarMailStatusDebugSnapshotForTest({
      currentWarId: "1001324",
      trackedTarget: {
        channelId: "111",
        messageId: "222",
        warId: "1001324",
        source: "war_mail_lifecycle",
      },
      matchesCurrentMailConfig: true,
      status: "posted",
      reconciliationOutcome: "exists",
    });

    const lines = buildMailStatusDebugLinesForTest(debug).join("\n");
    expect(lines).toContain("Current war id: 1001324");
    expect(lines).toContain("Tracked mail war id: 1001324");
    expect(lines).toContain("Tracked channel id: 111");
    expect(lines).toContain("Tracked message id: 222");
    expect(lines).toContain("Tracked message exists: yes");
    expect(lines).toContain("Current war/config matches tracked: yes");
    expect(lines).toContain("Winning source: WarMailLifecycle");
    expect(lines).toContain("Final normalized status: posted");
  });
});
