import axios from "axios";

const PUBLIC_SHEETS_TIMEOUT_MS = 15000;

export type PublicPublishedWorkbookTab = {
  title: string;
  pageUrl: string;
  gid: string;
};

export type PublicPublishedWorkbook = {
  title: string | null;
  tabs: PublicPublishedWorkbookTab[];
};

/** Purpose: read published Google Sheets workbooks without using OAuth or service-account credentials. */
export class PublicGoogleSheetsService {
  async readPublishedWorkbook(workbookUrl: string): Promise<PublicPublishedWorkbook> {
    const html = await this.fetchHtml(workbookUrl);
    const title = parseDocumentTitle(html);
    const tabs = parsePublishedWorkbookTabs(html);
    if (tabs.length <= 0) {
      throw new Error(
        "Unable to read the public Google Sheet import. No published tabs were found on the workbook page.",
      );
    }

    return { title, tabs };
  }

  async readPublishedSheetValues(pageUrl: string): Promise<string[][]> {
    const html = await this.fetchHtml(pageUrl);
    return parsePublishedSheetValues(html);
  }

  private async fetchHtml(url: string): Promise<string> {
    try {
      const response = await axios.get<string>(url, {
        responseType: "text",
        timeout: PUBLIC_SHEETS_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (response.status >= 400) {
        throw new Error(
          `Unable to read the public Google Sheet import. HTTP ${response.status} while fetching the published Google Sheet.`,
        );
      }
      return String(response.data ?? "");
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Unable to read the public Google Sheet import.")) {
        throw err;
      }
      throw new Error(
        `Unable to read the public Google Sheet import. ${normalizeErrorMessage(err, "Failed to fetch the published Google Sheet.")}`,
      );
    }
  }
}

function parseDocumentTitle(html: string): string | null {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const title = stripHtml(decodeHtmlEntities(match[1]))
    .replace(/\s*-\s*Google Sheets$/i, "")
    .trim();
  return title.length > 0 ? title : null;
}

function parsePublishedWorkbookTabs(html: string): PublicPublishedWorkbookTab[] {
  const tabs: PublicPublishedWorkbookTab[] = [];
  const pattern =
    /items\.push\(\{[\s\S]*?name:\s*"((?:\\.|[^"])*)",[\s\S]*?pageUrl:\s*"((?:\\.|[^"])*)",[\s\S]*?gid:\s*"((?:\\.|[^"])*)"/g;

  for (const match of html.matchAll(pattern)) {
    const title = sanitizeDisplayText(unescapeJsString(match[1] ?? ""));
    const pageUrl = sanitizeDisplayText(unescapeJsString(match[2] ?? ""));
    const gid = sanitizeDisplayText(unescapeJsString(match[3] ?? ""));
    if (!title || !pageUrl || !gid) continue;
    tabs.push({ title, pageUrl, gid });
  }

  return tabs;
}

function parsePublishedSheetValues(html: string): string[][] {
  const tableHtml =
    html.match(/<table[^>]*class="[^"]*\bwaffle\b[^"]*"[\s\S]*?<\/table>/i)?.[0] ??
    html.match(/<table[\s\S]*?<\/table>/i)?.[0] ??
    "";
  if (!tableHtml) return [];

  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cellMatch) =>
      sanitizePublishedCellText(stripHtml(decodeHtmlEntities(cellMatch[1] ?? ""))),
    );
    if (cells.some((cell) => cell.length > 0)) {
      rows.push(cells);
    }
  }

  return rows;
}

function stripHtml(input: string): string {
  return String(input ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(input: string): string {
  return String(input ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value) => String.fromCharCode(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCharCode(Number.parseInt(value, 16)));
}

function unescapeJsString(input: string): string {
  return String(input ?? "").replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_match, escapeSeq: string) => {
    if (escapeSeq.startsWith("x")) {
      return String.fromCharCode(Number.parseInt(escapeSeq.slice(1), 16));
    }
    if (escapeSeq.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escapeSeq.slice(1), 16));
    }
    switch (escapeSeq) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      default:
        return escapeSeq;
    }
  });
}

function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePublishedCellText(input: unknown): string {
  return String(input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}
