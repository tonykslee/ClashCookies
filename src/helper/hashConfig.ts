import { createHash } from "crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((a, b) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashMessageConfig(config: unknown): string {
  const normalized = JSON.stringify(sortValue(config) ?? null);
  return createHash("sha256").update(normalized).digest("hex");
}
