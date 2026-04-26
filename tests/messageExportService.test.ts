import { describe, expect, it } from "vitest";
import { buildMessageExportResult } from "../src/services/MessageExportService";

function makeMessage(input: {
  id: string;
  createdTimestamp: number;
  content?: string;
  displayName?: string;
  username?: string;
  attachments?: number;
  embeds?: number;
  stickers?: number;
}) {
  return {
    id: input.id,
    createdTimestamp: input.createdTimestamp,
    content: input.content ?? "",
    member: input.displayName ? { displayName: input.displayName } : null,
    author: {
      username: input.username ?? `user-${input.id}`,
      globalName: null,
      displayName: null,
    },
    attachments: { size: input.attachments ?? 0 },
    embeds: Array.from({ length: input.embeds ?? 0 }, () => ({})),
    stickers: { size: input.stickers ?? 0 },
  } as any;
}

describe("messageExportService", () => {
  it("formats messages chronologically with placeholders in an inline code block", () => {
    const result = buildMessageExportResult([
      makeMessage({
        id: "2",
        createdTimestamp: Date.parse("2026-04-20T00:05:00.000Z"),
        displayName: "Second User",
        content: "",
        attachments: 1,
      }),
      makeMessage({
        id: "1",
        createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
        username: "first-user",
        content: "Hello there",
      }),
      makeMessage({
        id: "3",
        createdTimestamp: Date.parse("2026-04-20T00:10:00.000Z"),
        displayName: "Embed User",
        content: "",
        embeds: 1,
        stickers: 2,
      }),
    ]);

    expect(result.attachment).toBeUndefined();
    expect(result.content.startsWith("```text\n")).toBe(true);
    expect(result.content).toContain("[2026-04-20 00:00] first-user: Hello there");
    expect(result.content).toContain("[2026-04-20 00:05] Second User: [attachments: 1]");
    expect(result.content).toContain("[2026-04-20 00:10] Embed User: [embeds: 1; stickers: 2]");
  });

  it("returns a txt attachment for long exports", () => {
    const result = buildMessageExportResult([
      makeMessage({
        id: "1",
        createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
        displayName: "Long User",
        content: "x".repeat(2100),
      }),
    ]);

    expect(result.attachment).toBeTruthy();
    expect(result.content).toContain(".txt attachment");
    expect(result.attachment?.name.endsWith(".txt")).toBe(true);
    expect(result.attachment?.buffer.toString("utf8")).toContain("Long User");
  });
});
