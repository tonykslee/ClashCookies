import { describe, expect, it } from "vitest";
import {
  buildFwaBaseSwapSplitPostCustomId,
  buildFwaComplianceViewCustomId,
  buildFwaMatchSendMailCustomId,
  buildMatchTypeActionCustomId,
  buildPointsPostButtonCustomId,
  createTransientFwaKey,
  isFwaBaseSwapSplitPostButtonCustomId,
  isFwaComplianceViewButtonCustomId,
  isFwaMatchSendMailButtonCustomId,
  isPointsPostButtonCustomId,
  parseFwaBaseSwapSplitPostCustomId,
  parseFwaComplianceViewCustomId,
  parseFwaMatchSendMailCustomId,
  parseMatchTypeActionCustomId,
  parsePointsPostButtonCustomId,
} from "../src/commands/fwa/customIds";

describe("fwa custom-id helpers", () => {
  it("round-trips match-type action ids and normalizes tag", () => {
    const customId = buildMatchTypeActionCustomId({
      userId: "123",
      tag: "#ab12cd",
      targetType: "FWA",
    });

    expect(parseMatchTypeActionCustomId(customId)).toEqual({
      userId: "123",
      tag: "AB12CD",
      targetType: "FWA",
    });
  });

  it("rejects malformed match-type action ids", () => {
    expect(parseMatchTypeActionCustomId("fwa-match-type-action:123:ABC:BAD")).toBeNull();
    expect(parseMatchTypeActionCustomId("fwa-match-type-action:123:ABC")).toBeNull();
  });

  it("round-trips send-mail ids and supports selector checks", () => {
    const customId = buildFwaMatchSendMailCustomId("321", "payload", "#qwerty");

    expect(isFwaMatchSendMailButtonCustomId(customId)).toBe(true);
    expect(parseFwaMatchSendMailCustomId(customId)).toEqual({
      userId: "321",
      key: "payload",
      tag: "QWERTY",
    });
  });

  it("round-trips points-post ids and supports selector checks", () => {
    const customId = buildPointsPostButtonCustomId("777");

    expect(isPointsPostButtonCustomId(customId)).toBe(true);
    expect(parsePointsPostButtonCustomId(customId)).toEqual({ userId: "777" });
  });

  it("creates transient payload keys", () => {
    const keyA = createTransientFwaKey();
    const keyB = createTransientFwaKey();

    expect(keyA.length).toBeGreaterThan(6);
    expect(keyB.length).toBeGreaterThan(6);
    expect(keyA).not.toBe(keyB);
  });

  it("round-trips fwa compliance view custom ids", () => {
    const customId = buildFwaComplianceViewCustomId({
      userId: "444",
      key: "abc123",
      action: "open_missed",
    });

    expect(isFwaComplianceViewButtonCustomId(customId)).toBe(true);
    expect(parseFwaComplianceViewCustomId(customId)).toEqual({
      userId: "444",
      key: "abc123",
      action: "open_missed",
    });
  });

  it("round-trips base-swap split-post custom ids", () => {
    const customId = buildFwaBaseSwapSplitPostCustomId({
      userId: "999",
      key: "base-swap-key",
      action: "yes",
    });
    expect(isFwaBaseSwapSplitPostButtonCustomId(customId)).toBe(true);
    expect(parseFwaBaseSwapSplitPostCustomId(customId)).toEqual({
      userId: "999",
      key: "base-swap-key",
      action: "yes",
    });
    expect(parseFwaBaseSwapSplitPostCustomId("fwa-base-swap-split-post:999:key:nope")).toBeNull();
  });
});
