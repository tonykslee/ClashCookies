export const DISCORD_EMBED_TEXT_LIMIT = 4096;
export const DISCORD_EMBED_FIELD_NAME_LIMIT = 256;
export const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024;
export const DISCORD_EMBED_FIELD_COUNT_LIMIT = 25;

export type DiscordEmbedTextLike = {
  title?: string | null;
  description?: string | null;
  author?: { name?: string | null } | null;
  footer?: { text?: string | null } | null;
  fields?: Array<{ name?: string | null; value?: string | null }> | null;
};

export type DiscordEmbedTextMetrics = {
  titleLength: number;
  descriptionLength: number;
  authorNameLength: number;
  footerTextLength: number;
  fieldCount: number;
  maxFieldNameLength: number;
  maxFieldValueLength: number;
  estimatedTextLength: number;
  fieldLengths: Array<{ nameLength: number; valueLength: number }>;
};

function normalizeText(input: unknown): string {
  return String(input ?? "");
}

export function measureDiscordEmbedText(embed: DiscordEmbedTextLike): number {
  return summarizeDiscordEmbedText(embed).estimatedTextLength;
}

export function isDiscordEmbedTextWithinLimits(
  metrics: DiscordEmbedTextMetrics,
): boolean {
  return (
    metrics.titleLength <= DISCORD_EMBED_TEXT_LIMIT &&
    metrics.descriptionLength <= DISCORD_EMBED_TEXT_LIMIT &&
    metrics.authorNameLength <= DISCORD_EMBED_TEXT_LIMIT &&
    metrics.footerTextLength <= DISCORD_EMBED_TEXT_LIMIT &&
    metrics.fieldCount <= DISCORD_EMBED_FIELD_COUNT_LIMIT &&
    metrics.maxFieldNameLength <= DISCORD_EMBED_FIELD_NAME_LIMIT &&
    metrics.maxFieldValueLength <= DISCORD_EMBED_FIELD_VALUE_LIMIT &&
    metrics.estimatedTextLength <= DISCORD_EMBED_TEXT_LIMIT
  );
}

export function summarizeDiscordEmbedText(embed: DiscordEmbedTextLike): DiscordEmbedTextMetrics {
  const titleLength = normalizeText(embed.title).length;
  const descriptionLength = normalizeText(embed.description).length;
  const authorNameLength = normalizeText(embed.author?.name).length;
  const footerTextLength = normalizeText(embed.footer?.text).length;
  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  const fieldLengths = fields.map((field) => ({
    nameLength: normalizeText(field?.name).length,
    valueLength: normalizeText(field?.value).length,
  }));
  const maxFieldNameLength =
    fieldLengths.length > 0 ? Math.max(...fieldLengths.map((field) => field.nameLength)) : 0;
  const maxFieldValueLength =
    fieldLengths.length > 0 ? Math.max(...fieldLengths.map((field) => field.valueLength)) : 0;
  const estimatedTextLength =
    titleLength +
    descriptionLength +
    authorNameLength +
    footerTextLength +
    fieldLengths.reduce((sum, field) => sum + field.nameLength + field.valueLength, 0);

  return {
    titleLength,
    descriptionLength,
    authorNameLength,
    footerTextLength,
    fieldCount: fields.length,
    maxFieldNameLength,
    maxFieldValueLength,
    estimatedTextLength,
    fieldLengths,
  };
}

export function truncateDiscordText(input: string, maxLength: number, suffix = "..."): string {
  const normalized = normalizeText(input);
  if (maxLength <= 0) return "";
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= suffix.length) {
    return suffix.slice(0, maxLength);
  }
  return `${normalized.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

export function truncateDiscordMultilineText(
  input: string,
  maxLength: number,
  options?: {
    suffix?: string;
  },
): string {
  const normalized = normalizeText(input);
  const suffix = options?.suffix ?? " ... truncated to fit Discord limits";
  if (maxLength <= 0) return "";
  if (normalized.length <= maxLength) return normalized;

  const lines = normalized.split("\n");
  const out: string[] = [];
  let remaining = maxLength;

  for (const line of lines) {
    const separator = out.length > 0 ? 1 : 0;
    if (remaining <= separator) {
      break;
    }
    remaining -= separator;

    if (line.length <= remaining) {
      out.push(line);
      remaining -= line.length;
      continue;
    }

    const truncated = truncateDiscordText(line, remaining, suffix);
    out.push(truncated);
    remaining = 0;
    break;
  }

  return out.join("\n");
}

export function truncateDiscordFieldName(name: string): string {
  return truncateDiscordText(name, DISCORD_EMBED_FIELD_NAME_LIMIT);
}

export function truncateDiscordFieldValue(value: string): string {
  return truncateDiscordText(value, DISCORD_EMBED_FIELD_VALUE_LIMIT);
}
