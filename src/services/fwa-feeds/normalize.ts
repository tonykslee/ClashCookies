import { normalizeTag, normalizeTagBare } from "../war-events/core";

/** Purpose: normalize clan/player tags to canonical #UPPER format. */
export function normalizeFwaTag(input: string | null | undefined): string {
  return normalizeTag(input);
}

/** Purpose: normalize clan/player tags to uppercase without leading '#'. */
export function normalizeFwaTagBare(input: string | null | undefined): string {
  return normalizeTagBare(input);
}

/** Purpose: trim optional text fields and collapse empty values to null. */
export function normalizeText(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Purpose: parse finite integer values with null fallback for invalid input. */
export function toIntOrNull(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) return null;
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Purpose: parse finite float values with null fallback for invalid input. */
export function toFloatOrNull(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) return null;
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Purpose: parse boolean-like values from FWAStats feed rows. */
export function toBoolOrNull(input: unknown): boolean | null {
  if (typeof input === "boolean") return input;
  if (typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

/** Purpose: parse date values from feed rows using strict finite-date checks. */
export function toDateOrNull(input: unknown): Date | null {
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** Purpose: format row values into deterministic primitives for hashing and comparison. */
export function stableHashValue(input: unknown): unknown {
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map((value) => stableHashValue(value));
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = stableHashValue(record[key]);
    }
    return out;
  }
  return input ?? null;
}
