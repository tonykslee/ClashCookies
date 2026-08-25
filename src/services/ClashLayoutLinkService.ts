const CLASH_LAYOUT_HOST = "link.clashofclans.com";
const OPEN_LAYOUT_ACTION = "OpenLayout";

export type ParsedClashLayoutLink = {
  layoutLink: string;
  layoutId: string;
  townHall: number;
  layoutKind: string;
};

/** Purpose: identify malformed input without exposing URL-parser implementation details to callers. */
export class InvalidClashLayoutLinkError extends Error {
  constructor(layoutLink: string) {
    super(`Invalid Clash layout link: ${layoutLink}`);
    this.name = "InvalidClashLayoutLinkError";
  }
}

/** Purpose: parse and validate a generic Clash layout link for future layout commands and posts. */
export function parseClashLayoutLink(input: string): ParsedClashLayoutLink {
  const layoutLink = input.trim();
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(layoutLink);
  } catch {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.host !== CLASH_LAYOUT_HOST ||
    parsedUrl.searchParams.get("action") !== OPEN_LAYOUT_ACTION
  ) {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  const layoutId = parsedUrl.searchParams.get("id");
  if (!layoutId) {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  const layoutIdParts = layoutId.split(":");
  if (layoutIdParts.length !== 3) {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  const [townHallToken, layoutKind, payload] = layoutIdParts;
  const townHallMatch = /^TH([0-9]+)$/.exec(townHallToken);
  if (
    !townHallMatch ||
    !/^[A-Za-z0-9_-]+$/.test(layoutKind) ||
    !payload ||
    /\s/.test(payload)
  ) {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  const townHall = Number(townHallMatch[1]);
  if (!Number.isSafeInteger(townHall) || townHall < 1) {
    throw new InvalidClashLayoutLinkError(layoutLink);
  }

  return {
    layoutLink,
    layoutId,
    townHall,
    layoutKind,
  };
}
