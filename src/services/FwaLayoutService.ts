import { FwaLayoutType, FwaLayouts } from "@prisma/client";
import { prisma } from "../prisma";

export const FWA_LAYOUT_TYPES = [
  "RISINGDAWN",
  "BASIC",
  "ICE",
] as const satisfies readonly FwaLayoutType[];

export const FWA_LAYOUT_LINK_PREFIX =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH";

const MIN_SUPPORTED_TOWNHALL = 8;
const MAX_SUPPORTED_TOWNHALL = 18;

export type FwaLayoutSeedRow = {
  Townhall: number;
  Type: FwaLayoutType;
  LayoutLink: string;
  ImageUrl: string | null;
};

/** Purpose: normalize optional layout type input to a supported enum value. */
export function normalizeLayoutType(input?: string | null): FwaLayoutType {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "BASIC") return "BASIC";
  if (normalized === "ICE") return "ICE";
  return "RISINGDAWN";
}

/** Purpose: enforce supported Town Hall values for FWA layout lookup/edit flows. */
export function isSupportedTownhall(th: number): boolean {
  return Number.isInteger(th) && th >= MIN_SUPPORTED_TOWNHALL && th <= MAX_SUPPORTED_TOWNHALL;
}

/** Purpose: validate that a layout URL uses the expected Clash layout prefix. */
export function isValidFwaLayoutLink(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith(FWA_LAYOUT_LINK_PREFIX);
}

/** Purpose: validate optional image URL input for layout preview links. */
export function isValidImageUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Purpose: wrap links in angle brackets to suppress Discord embed expansion. */
export function wrapDiscordLink(url: string): string {
  return `<${url.trim()}>`;
}

/** Purpose: fetch all stored layout rows for paginated list rendering. */
export async function getAllFwaLayouts(): Promise<FwaLayouts[]> {
  return prisma.fwaLayouts.findMany({
    orderBy: { Townhall: "asc" },
  });
}

/** Purpose: fetch one stored layout by composite key (Townhall + Type). */
export async function getFwaLayout(
  townhall: number,
  type: FwaLayoutType
): Promise<FwaLayouts | null> {
  return prisma.fwaLayouts.findUnique({
    where: {
      Townhall_Type: {
        Townhall: townhall,
        Type: type,
      },
    },
  });
}

/** Purpose: upsert one layout row and only overwrite ImageUrl when explicitly provided. */
export async function upsertFwaLayout(params: {
  townhall: number;
  type: FwaLayoutType;
  layoutLink: string;
  imageUrl?: string;
}): Promise<FwaLayouts> {
  const trimmedLink = params.layoutLink.trim();
  const trimmedImageUrl = params.imageUrl?.trim();
  return prisma.fwaLayouts.upsert({
    where: {
      Townhall_Type: {
        Townhall: params.townhall,
        Type: params.type,
      },
    },
    create: {
      Townhall: params.townhall,
      Type: params.type,
      LayoutLink: trimmedLink,
      ImageUrl: trimmedImageUrl ?? null,
    },
    update: {
      LayoutLink: trimmedLink,
      ...(trimmedImageUrl !== undefined ? { ImageUrl: trimmedImageUrl } : {}),
    },
  });
}

/** Purpose: keep backward-compatible layout-link-only upserts for existing call sites. */
export async function upsertFwaLayoutLink(params: {
  townhall: number;
  type: FwaLayoutType;
  layoutLink: string;
}): Promise<FwaLayouts> {
  return upsertFwaLayout(params);
}

/** Purpose: seed or refresh canonical layout rows using composite-key upserts. */
export async function upsertFwaLayoutSeedRows(
  rows: readonly FwaLayoutSeedRow[]
): Promise<number> {
  for (const row of rows) {
    await prisma.fwaLayouts.upsert({
      where: {
        Townhall_Type: {
          Townhall: row.Townhall,
          Type: row.Type,
        },
      },
      create: {
        Townhall: row.Townhall,
        Type: row.Type,
        LayoutLink: row.LayoutLink,
        ImageUrl: row.ImageUrl,
      },
      update: {
        LayoutLink: row.LayoutLink,
        ImageUrl: row.ImageUrl,
      },
    });
  }

  return rows.length;
}
