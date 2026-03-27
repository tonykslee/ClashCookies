import { describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { upsertRecruitmentTemplate } from "../src/services/RecruitmentService";

describe("RecruitmentService persistence", () => {
  it("uses guild-scoped conflict identity when upserting templates", async () => {
    prismaMock.$executeRaw.mockResolvedValue(1);

    await upsertRecruitmentTemplate({
      guildId: "guild-1",
      clanTag: "#pql0289",
      platform: "band",
      body: "Recruitment body",
      imageUrls: [],
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    const query = prismaMock.$executeRaw.mock.calls[0]?.[0] as {
      strings: string[];
      values: unknown[];
    };
    const sqlText = query.strings.join(" ");
    expect(sqlText).toContain('INSERT INTO "RecruitmentTemplate"');
    expect(sqlText).toContain('ON CONFLICT ("guildId", "clanTag", "platform")');
    expect(query.values).toContain("guild-1");
    expect(query.values).toContain("PQL0289");
    expect(query.values).toContain("band");
  });
});
