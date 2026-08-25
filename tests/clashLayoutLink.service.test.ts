import { describe, expect, it } from "vitest";
import {
  InvalidClashLayoutLinkError,
  parseClashLayoutLink,
} from "../src/services/ClashLayoutLinkService";

const TH18_WB_LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AAAAAMwAAAAJ8_jtp6RRc8U3ZCZTYot51";
const TH12_HV_LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH12%3AHV%3AAAAABgAAAALxrYMCIguGWafzazqpHIsi";

describe("parseClashLayoutLink", () => {
  it("parses a URL-encoded TH18 WB layout", () => {
    expect(parseClashLayoutLink(TH18_WB_LINK)).toEqual({
      layoutLink: TH18_WB_LINK,
      layoutId: "TH18:WB:AAAAMwAAAAJ8_jtp6RRc8U3ZCZTYot51",
      townHall: 18,
      layoutKind: "WB",
    });
  });

  it("parses a URL-encoded HV layout", () => {
    const parsed = parseClashLayoutLink(TH12_HV_LINK);

    expect(parsed.townHall).toBe(12);
    expect(parsed.layoutKind).toBe("HV");
    expect(parsed.layoutId).toBe("TH12:HV:AAAABgAAAALxrYMCIguGWafzazqpHIsi");
  });

  it("accepts future layout-kind tokens without an FWA-specific allowlist", () => {
    const parsed = parseClashLayoutLink(
      "https://link.clashofclans.com/en?action=OpenLayout&id=TH20%3AFUTURE_KIND%3APAYLOAD_123"
    );

    expect(parsed.townHall).toBe(20);
    expect(parsed.layoutKind).toBe("FUTURE_KIND");
  });

  it.each([
    "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB",
    "https://link.clashofclans.com/en?action=OpenLayout&id=not-a-layout-id",
    "https://example.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD",
    "http://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD",
    "https://link.clashofclans.com:8443/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD",
    "https://link.clashofclans.com/en?action=Other&id=TH18%3AWB%3APAYLOAD",
    "https://link.clashofclans.com/en?id=TH18%3AWB%3APAYLOAD",
    "https://link.clashofclans.com/en?action=OpenLayout",
  ])("rejects malformed or non-Clash link %s", (link) => {
    expect(() => parseClashLayoutLink(link)).toThrow(InvalidClashLayoutLinkError);
  });

  it("rejects an empty or whitespace-only link deterministically", () => {
    expect(() => parseClashLayoutLink(" ")).toThrow(InvalidClashLayoutLinkError);
    expect(() => parseClashLayoutLink("")).toThrow(InvalidClashLayoutLinkError);
  });
});
