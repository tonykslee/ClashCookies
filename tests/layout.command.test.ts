import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaLayouts, FwaLayoutType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  fwaLayouts: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Layout, buildLayoutListEmbedsForTest } from "../src/commands/Layout";
import {
  isSupportedTownhall,
  isValidFwaLayoutLink,
  isValidImageUrl,
  normalizeLayoutType,
  wrapDiscordLink,
} from "../src/services/FwaLayoutService";

/** Purpose: build a deterministic FwaLayouts row for command and embed tests. */
function buildRow(input: {
  Townhall: number;
  Type: FwaLayoutType;
  LayoutLink: string;
  ImageUrl: string | null;
}): FwaLayouts {
  return {
    ...input,
    LastUpdated: new Date("2026-03-19T00:00:00.000Z"),
  };
}

/** Purpose: create a minimal slash interaction mock for /layout run-path tests. */
function makeInteraction(params: {
  th?: number | null;
  type?: string | null;
  edit?: string | null;
  imgUrl?: string | null;
  visibility?: "private" | "public";
  isAdmin?: boolean;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const collector = {
    on: vi.fn().mockReturnThis(),
  };
  const fetchReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: vi.fn(() => collector),
  });

  const interaction = {
    id: "interaction-1",
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    memberPermissions: {
      has: vi.fn(() => params.isAdmin ?? true),
    },
    reply,
    editReply,
    fetchReply,
    options: {
      getInteger: vi.fn((name: string) => {
        if (name === "th") return params.th ?? null;
        return null;
      }),
      getString: vi.fn((name: string) => {
        if (name === "type") return params.type ?? null;
        if (name === "edit") return params.edit ?? null;
        if (name === "img-url") return params.imgUrl ?? null;
        if (name === "visibility") return params.visibility ?? "private";
        return null;
      }),
    },
  };

  return { interaction, reply, editReply, fetchReply, collector };
}

describe("/layout helper logic", () => {
  it("validates layout links using the Clash layout prefix", () => {
    expect(
      isValidFwaLayoutLink(
        "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AAAAABgAAAAL2WyTYmDxC5gKRGZcTtH3d"
      )
    ).toBe(true);
    expect(
      isValidFwaLayoutLink(
        " https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AAAAAUAAAAAH2lvxn0AFoRDXqRUyoDxWd "
      )
    ).toBe(true);
    expect(isValidFwaLayoutLink("https://example.com/not-layout")).toBe(false);
  });

  it("validates image URLs with http/https only", () => {
    expect(isValidImageUrl("https://i.imgur.com/bCISCn1.png")).toBe(true);
    expect(isValidImageUrl(" http://example.com/test.jpg ")).toBe(true);
    expect(isValidImageUrl("ftp://example.com/test.jpg")).toBe(false);
    expect(isValidImageUrl("not-a-url")).toBe(false);
  });

  it("enforces TH8-TH18 support range", () => {
    expect(isSupportedTownhall(7)).toBe(false);
    expect(isSupportedTownhall(8)).toBe(true);
    expect(isSupportedTownhall(18)).toBe(true);
    expect(isSupportedTownhall(19)).toBe(false);
  });

  it("defaults missing type input to RISINGDAWN", () => {
    expect(normalizeLayoutType(undefined)).toBe("RISINGDAWN");
    expect(normalizeLayoutType(null)).toBe("RISINGDAWN");
    expect(normalizeLayoutType("basic")).toBe("BASIC");
  });

  it("wraps links in angle brackets for Discord-safe posting", () => {
    expect(wrapDiscordLink("https://link.clashofclans.com/en?action=OpenLayout&id=TH12")).toBe(
      "<https://link.clashofclans.com/en?action=OpenLayout&id=TH12>"
    );
  });
});

describe("/layout command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("/layout with no args renders paginated embeds in fixed type order", async () => {
    prismaMock.fwaLayouts.findMany.mockResolvedValue([
      buildRow({
        Townhall: 10,
        Type: "RISINGDAWN",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH10%3AWB%3AAAAAOgAAAAJh_-F870fFMcVCr_wSnsEY",
        ImageUrl: "https://i.imgur.com/4g893Yt.jpeg",
      }),
      buildRow({
        Townhall: 8,
        Type: "BASIC",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH8%3AWB%3AAAAAKgAAAAKANkTLQf__hePWp7JBwmVc",
        ImageUrl: null,
      }),
      buildRow({
        Townhall: 9,
        Type: "ICE",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH9%3AWB%3AAAAAGAAAAAKguigWRLLurILLBvVA5rQE",
        ImageUrl: null,
      }),
    ]);

    const { interaction, reply, fetchReply } = makeInteraction({});
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.findMany).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(fetchReply).toHaveBeenCalledTimes(1);

    const payload = reply.mock.calls[0]?.[0];
    const firstEmbed = payload.embeds[0].toJSON();
    expect(firstEmbed.title).toBe("FWA Layouts - RISINGDAWN");
    expect(firstEmbed.footer?.text).toBe("Page 1/3");
    expect(payload.components.length).toBe(1);
  });

  it("/layout th:11 defaults type to RISINGDAWN", async () => {
    prismaMock.fwaLayouts.findUnique.mockResolvedValue(
      buildRow({
        Townhall: 11,
        Type: "RISINGDAWN",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AAAAAUAAAAAH2lvxn0AFoRDXqRUyoDxWd",
        ImageUrl: "https://i.imgur.com/APZjSyh.png",
      })
    );

    const { interaction, reply } = makeInteraction({ th: 11 });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          Townhall_Type: {
            Townhall: 11,
            Type: "RISINGDAWN",
          },
        },
      })
    );

    const payload = reply.mock.calls[0]?.[0];
    expect(String(payload.content)).toContain("TH11 RISINGDAWN layout:");
    expect(String(payload.content)).toContain(
      "<https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AAAAAUAAAAAH2lvxn0AFoRDXqRUyoDxWd>"
    );
    expect(String(payload.content)).toContain("Image: https://i.imgur.com/APZjSyh.png");
  });

  it("/layout th:12 type:BASIC fetches the requested type row", async () => {
    prismaMock.fwaLayouts.findUnique.mockResolvedValue(
      buildRow({
        Townhall: 12,
        Type: "BASIC",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AAAAABgAAAALxrYMCIguGWafzazqpHIsi",
        ImageUrl: null,
      })
    );

    const { interaction, reply } = makeInteraction({ th: 12, type: "BASIC" });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          Townhall_Type: {
            Townhall: 12,
            Type: "BASIC",
          },
        },
      })
    );

    const payload = reply.mock.calls[0]?.[0];
    expect(String(payload.content)).toContain("TH12 BASIC layout:");
    expect(String(payload.content)).not.toContain("Image:");
  });

  it("returns ephemeral missing-row error when no saved layout exists", async () => {
    prismaMock.fwaLayouts.findUnique.mockResolvedValue(null);

    const { interaction, reply } = makeInteraction({ th: 12, type: "ICE" });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "No layout saved for TH12 (ICE).",
      })
    );
  });

  it("admin edit with img-url updates both LayoutLink and ImageUrl", async () => {
    const updatedLink =
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AEDITED";
    const updatedImage = "https://i.imgur.com/new-image.png";
    prismaMock.fwaLayouts.upsert.mockResolvedValue(
      buildRow({
        Townhall: 11,
        Type: "RISINGDAWN",
        LayoutLink: updatedLink,
        ImageUrl: updatedImage,
      })
    );

    const { interaction, reply } = makeInteraction({
      th: 11,
      type: "RISINGDAWN",
      edit: updatedLink,
      imgUrl: updatedImage,
      isAdmin: true,
    });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          LayoutLink: updatedLink,
          ImageUrl: updatedImage,
        }),
        update: expect.objectContaining({
          LayoutLink: updatedLink,
          ImageUrl: updatedImage,
        }),
      })
    );

    const payload = reply.mock.calls[0]?.[0];
    expect(String(payload.content)).toContain("Saved TH11 RISINGDAWN layout:");
    expect(String(payload.content)).toContain(`<${updatedLink}>`);
    expect(String(payload.content)).toContain(`Image: ${updatedImage}`);
  });

  it("admin edit without img-url preserves existing image by omitting ImageUrl update", async () => {
    const updatedLink =
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AEDITED";
    prismaMock.fwaLayouts.upsert.mockResolvedValue(
      buildRow({
        Townhall: 11,
        Type: "RISINGDAWN",
        LayoutLink: updatedLink,
        ImageUrl: "https://i.imgur.com/existing.png",
      })
    );

    const { interaction } = makeInteraction({ th: 11, edit: updatedLink, isAdmin: true });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          LayoutLink: updatedLink,
        },
      })
    );
  });

  it("create payload stores img-url when provided", async () => {
    const updatedLink =
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH13%3AWB%3AEDITED";
    const updatedImage = "https://i.imgur.com/create-image.jpg";
    prismaMock.fwaLayouts.upsert.mockResolvedValue(
      buildRow({
        Townhall: 13,
        Type: "RISINGDAWN",
        LayoutLink: updatedLink,
        ImageUrl: updatedImage,
      })
    );

    const { interaction } = makeInteraction({
      th: 13,
      edit: updatedLink,
      imgUrl: updatedImage,
      isAdmin: true,
    });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ImageUrl: updatedImage,
        }),
      })
    );
  });

  it("create payload defaults ImageUrl to null when img-url is omitted", async () => {
    const updatedLink =
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH14%3AWB%3AEDITED";
    prismaMock.fwaLayouts.upsert.mockResolvedValue(
      buildRow({
        Townhall: 14,
        Type: "RISINGDAWN",
        LayoutLink: updatedLink,
        ImageUrl: null,
      })
    );

    const { interaction } = makeInteraction({
      th: 14,
      edit: updatedLink,
      isAdmin: true,
    });
    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ImageUrl: null,
        }),
      })
    );
  });

  it("img-url without edit is rejected", async () => {
    const { interaction, reply } = makeInteraction({
      th: 12,
      imgUrl: "https://i.imgur.com/test.png",
      isAdmin: true,
    });

    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "You must provide `edit` when using `img-url`.",
      })
    );
  });

  it("invalid img-url is rejected", async () => {
    const { interaction, reply } = makeInteraction({
      th: 11,
      edit: "https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AEDITED",
      imgUrl: "notaurl",
      isAdmin: true,
    });

    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "Invalid image URL. Expected a valid http(s) URL.",
      })
    );
  });

  it("non-admin edit with img-url is denied", async () => {
    const { interaction, reply } = makeInteraction({
      th: 11,
      edit: "https://link.clashofclans.com/en?action=OpenLayout&id=TH11%3AWB%3AEDITED",
      imgUrl: "https://i.imgur.com/example.png",
      isAdmin: false,
    });

    await Layout.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaLayouts.upsert).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "You do not have permission to edit layouts.",
      })
    );
  });

  it("fetch mode shows updated image URL when present", async () => {
    const updatedImage = "https://i.imgur.com/updated-fetch.png";
    prismaMock.fwaLayouts.findUnique.mockResolvedValue(
      buildRow({
        Townhall: 12,
        Type: "RISINGDAWN",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AUPDATED",
        ImageUrl: updatedImage,
      })
    );

    const { interaction, reply } = makeInteraction({ th: 12, type: "RISINGDAWN" });
    await Layout.run({} as any, interaction as any, {} as any);

    const payload = reply.mock.calls[0]?.[0];
    expect(String(payload.content)).toContain(`Image: ${updatedImage}`);
  });

  it("list mode shows updated image URL when stored", () => {
    const updatedImage = "https://i.imgur.com/updated-list.webp";
    const embeds = buildLayoutListEmbedsForTest([
      buildRow({
        Townhall: 12,
        Type: "RISINGDAWN",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AAAAABgAAAAL2WyTYmDxC5gKRGZcTtH3d",
        ImageUrl: updatedImage,
      }),
      buildRow({
        Townhall: 12,
        Type: "BASIC",
        LayoutLink:
          "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AAAAABgAAAALxrYMCIguGWafzazqpHIsi",
        ImageUrl: null,
      }),
    ]);

    expect(embeds).toHaveLength(3);
    const rising = embeds[0].toJSON();
    const basic = embeds[1].toJSON();

    expect(String(rising.description ?? "")).toContain(`Image: ${updatedImage}`);
    expect(String(basic.description ?? "")).not.toContain("Image:");
  });
});
