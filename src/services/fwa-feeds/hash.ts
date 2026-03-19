import { createHash } from "node:crypto";
import { stableHashValue } from "./normalize";

/** Purpose: build a deterministic content hash for normalized feed payloads. */
export function computeFeedContentHash(rows: readonly unknown[]): string {
  const normalized = stableHashValue(rows);
  const serialized = JSON.stringify(normalized);
  return createHash("sha256").update(serialized).digest("hex");
}
