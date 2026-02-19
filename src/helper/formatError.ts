type ErrorLike = {
  message?: string;
  code?: string | number;
  status?: number;
  response?: { status?: number; data?: unknown };
};

export function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  const e = err as ErrorLike;
  const parts: string[] = [];

  if (e.message) parts.push(e.message);
  if (e.code) parts.push(`code=${String(e.code)}`);
  if (e.status) parts.push(`status=${e.status}`);
  if (e.response?.status) parts.push(`http=${e.response.status}`);

  if (parts.length > 0) return parts.join(" | ");
  return "Unhandled non-error throw";
}
