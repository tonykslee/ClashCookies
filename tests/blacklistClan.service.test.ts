import { beforeEach, describe, expect, it, vi } from "vitest";

type BlacklistClanRow = {
  clanTag: string;
  clanName: string | null;
  sourceLabel: string;
  active: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const rows: BlacklistClanRow[] = [];

const prismaMock = vi.hoisted(() => ({
  blacklistClan: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  blacklistClanService,
  normalizeBlacklistSourceLabel,
  parseBlacklistClanTagsInput,
} from "../src/services/BlacklistClanService";

describe("blacklist clan service", () => {
  const now = new Date("2026-05-20T12:00:00.000Z");

  beforeEach(() => {
    rows.splice(0, rows.length);
    prismaMock.blacklistClan.findMany.mockReset();
    prismaMock.blacklistClan.upsert.mockReset();
    prismaMock.blacklistClan.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const clanTagFilter = where?.clanTag?.in;
      const activeFilter = where?.active;
      const filtered = rows.filter((row) => {
        const clanOk =
          !Array.isArray(clanTagFilter) || clanTagFilter.includes(row.clanTag);
        const activeOk =
          typeof activeFilter === "boolean" ? row.active === activeFilter : true;
        return clanOk && activeOk;
      });
      return [...filtered].sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        if (left.lastSeenAt.getTime() !== right.lastSeenAt.getTime()) {
          return right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
        }
        return left.clanTag.localeCompare(right.clanTag);
      });
    });
    prismaMock.blacklistClan.upsert.mockImplementation(async (args: any) => {
      const clanTag = String(args.where.clanTag ?? "");
      const existing = rows.find((row) => row.clanTag === clanTag);
      if (existing) {
        if (Object.prototype.hasOwnProperty.call(args.update, "clanName")) {
          existing.clanName = args.update.clanName;
        }
        existing.sourceLabel = args.update.sourceLabel ?? existing.sourceLabel;
        existing.active = args.update.active ?? existing.active;
        existing.lastSeenAt = args.update.lastSeenAt ?? existing.lastSeenAt;
        existing.updatedAt = now;
        return existing;
      }
      const created: BlacklistClanRow = {
        clanTag,
        clanName: args.create.clanName ?? null,
        sourceLabel: args.create.sourceLabel,
        active: args.create.active ?? true,
        firstSeenAt: args.create.firstSeenAt ?? now,
        lastSeenAt: args.create.lastSeenAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(created);
      return created;
    });
  });

  it("parses mixed blacklist clan tag input with invalid and duplicate buckets", () => {
    const parsed = parseBlacklistClanTagsInput("#PYLQ0289, PYLQ0288 PYLQ0289 bad");

    expect(parsed.validTags).toEqual(["#PYLQ0289", "#PYLQ0288"]);
    expect(parsed.invalidTags).toEqual(["bad"]);
    expect(parsed.duplicateTagsInRequest).toEqual(["#PYLQ0289"]);
  });

  it("normalizes empty source labels to the default manual import label", () => {
    expect(normalizeBlacklistSourceLabel("   ")).toBe("manual-import");
  });

  it("upserts blacklist clans idempotently and preserves firstSeenAt", async () => {
    const first = await blacklistClanService.upsertBlacklistClanTags({
      rawTags: "#PYLQ0289, PYLQ0288 PYLQ0280 #PYLQ0289",
      sourceLabel: "manual-import",
      active: false,
      now,
    });

    expect(first.added).toEqual(["#PYLQ0289", "#PYLQ0288", "#PYLQ0280"]);
    expect(first.updated).toEqual([]);
    expect(first.invalid).toEqual([]);
    expect(first.duplicateInRequest).toEqual(["#PYLQ0289"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.firstSeenAt).toEqual(now);
    expect(rows[0]?.lastSeenAt).toEqual(now);
    expect(rows[0]?.active).toBe(false);

    const secondNow = new Date("2026-05-20T13:00:00.000Z");
    const second = await blacklistClanService.upsertBlacklistClanTags({
      rawTags: "#PYLQ0289, PYLQ0288 PYLQ0280",
      sourceLabel: "reimport",
      active: true,
      now: secondNow,
    });

    expect(second.added).toEqual([]);
    expect(second.updated).toEqual(["#PYLQ0289", "#PYLQ0288", "#PYLQ0280"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.firstSeenAt).toEqual(now);
    expect(rows[0]?.lastSeenAt).toEqual(secondNow);
    expect(rows[0]?.sourceLabel).toBe("reimport");
    expect(rows[0]?.active).toBe(true);
  });

  it("lists blacklist clans with active rows first and optional active filtering", async () => {
    rows.push(
      {
        clanTag: "#PYLQ0289",
        clanName: "Alpha",
        sourceLabel: "manual-import",
        active: true,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        clanTag: "#PYLQ0288",
        clanName: null,
        sourceLabel: "manual-import",
        active: false,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
    );

    const allRows = await blacklistClanService.listBlacklistClans();
    expect(allRows.map((row) => row.clanTag)).toEqual(["#PYLQ0289", "#PYLQ0288"]);

    const activeRows = await blacklistClanService.listBlacklistClans({ active: true });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.clanTag).toBe("#PYLQ0289");
  });
});
