import { describe, expect, it } from "vitest";
import {
  buildFwaMatchSendMailCustomId,
  buildMatchTypeActionCustomId,
  buildPointsPostButtonCustomId,
  createTransientFwaKey,
  isFwaMatchSendMailButtonCustomId,
  isPointsPostButtonCustomId,
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
});
