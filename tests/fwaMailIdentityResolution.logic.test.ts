import { describe, expect, it } from "vitest";
import {
  buildFwaMailIdentityFailureMessageForTest,
  resolveFwaMailConfirmActionForTest,
} from "../src/commands/Fwa";

describe("fwa mail identity failure mapping", () => {
  it.each([
    [
      "not_in_war",
      "Cannot send mail: no active war is currently tracked for this clan.",
    ],
    [
      "partial_live_identity",
      "Cannot send mail yet: Clash of Clans has not returned the complete active-war identity. Run /force poll war-events and retry.",
    ],
    [
      "missing_current_row",
      "Cannot send mail: active-war tracking is missing for this clan. Run /force poll war-events and retry.",
    ],
    [
      "persisted_identity_mismatch",
      "Cannot send mail yet: the live war does not match the tracked active war. Run /force poll war-events and retry.",
    ],
    [
      "missing_preserved_id",
      "Cannot send mail yet: no safe stored war ID is available. Run /force poll war-events and retry.",
    ],
    [
      "conflicting_global_identity_ids",
      "Cannot send mail: conflicting active-war IDs were detected. Do not send mail; contact a bot administrator to repair the tracked war identity.",
    ],
    [
      "persistence_failure",
      "Cannot send mail because the active-war identity could not be saved. Run /force poll war-events and retry. If this continues, contact a bot administrator.",
    ],
  ] as const)(
    "maps %s to the actionable mail error",
    (reason, expected) => {
      expect(buildFwaMailIdentityFailureMessageForTest(reason)).toBe(expected);
    },
  );

  it("falls back to the generic safe message for unknown reasons", () => {
    expect(buildFwaMailIdentityFailureMessageForTest(null)).toBe(
      "Cannot send mail: the active war ID could not be resolved safely. Run /force poll war-events and retry.",
    );
    expect(buildFwaMailIdentityFailureMessageForTest(undefined)).toBe(
      "Cannot send mail: the active war ID could not be resolved safely. Run /force poll war-events and retry.",
    );
  });
});

describe("fwa mail confirmation decision", () => {
  const resolvedIdentity = {
    status: "resolved" as const,
    warId: 1001,
    source: "materialized_missing_id" as const,
    liveValidated: true,
  };

  it("uses the latest rerendered blocked reason and ignores a previously resolved preview", () => {
    const preview = {
      activeWarIdentityResolution: resolvedIdentity,
      mailChannelId: "mail-channel-1",
      unavailableReasons: [] as string[],
    };
    const latest = {
      ...preview,
      activeWarIdentityResolution: {
        status: "blocked" as const,
        warId: null,
        reason: "partial_live_identity" as const,
      },
      unavailableReasons: [
        "Cannot send mail yet: Clash of Clans has not returned the complete active-war identity. Run /force poll war-events and retry.",
      ],
    };

    const decision = resolveFwaMailConfirmActionForTest(latest, {
      pingRole: true,
    });

    expect(preview.activeWarIdentityResolution.status).toBe("resolved");
    expect(decision).toEqual({
      kind: "blocked",
      message:
        "Cannot send mail yet: Clash of Clans has not returned the complete active-war identity. Run /force poll war-events and retry.",
      activeWarIdentityResolution: latest.activeWarIdentityResolution,
    });
  });

  it("accepts a recovered latest rerender even if the preview was previously blocked", () => {
    const preview = {
      activeWarIdentityResolution: {
        status: "blocked" as const,
        warId: null,
        reason: "missing_current_row" as const,
      },
      mailChannelId: "mail-channel-1",
      unavailableReasons: [
        "Cannot send mail: active-war tracking is missing for this clan. Run /force poll war-events and retry.",
      ],
    };
    const latest = {
      ...preview,
      activeWarIdentityResolution: resolvedIdentity,
      unavailableReasons: [],
    };

    const decisionWithPing = resolveFwaMailConfirmActionForTest(latest, {
      pingRole: true,
    });
    const decisionWithoutPing = resolveFwaMailConfirmActionForTest(latest, {
      pingRole: false,
    });

    expect(preview.activeWarIdentityResolution.status).toBe("blocked");
    expect(decisionWithPing).toEqual({
      kind: "send",
      activeWarIdentityResolution: resolvedIdentity,
    });
    expect(decisionWithoutPing).toEqual(decisionWithPing);
  });

  it("keeps an exact or newly materialized identity unchanged when sending", () => {
    const latest = {
      activeWarIdentityResolution: resolvedIdentity,
      mailChannelId: "mail-channel-1",
      unavailableReasons: [] as string[],
    };

    const decision = resolveFwaMailConfirmActionForTest(latest, {
      pingRole: true,
    });

    expect(decision).toEqual({
      kind: "send",
      activeWarIdentityResolution: resolvedIdentity,
    });
  });
});
