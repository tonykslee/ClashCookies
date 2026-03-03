type ErrorLike = {
  message?: string;
  code?: string | number;
  status?: number;
  response?: { status?: number; data?: unknown };
};

function compactResponseData(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return null;
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const candidates: string[] = [];
    const direct = ["error_description", "error", "message", "status"];
    for (const key of direct) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        candidates.push(`${key}=${value.trim()}`);
      }
    }
    const nestedError = obj.error as Record<string, unknown> | undefined;
    if (nestedError && typeof nestedError === "object") {
      const nestedMessage = nestedError.message;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) {
        candidates.push(`error.message=${nestedMessage.trim()}`);
      }
      const nestedStatus = nestedError.status;
      if (typeof nestedStatus === "string" && nestedStatus.trim()) {
        candidates.push(`error.status=${nestedStatus.trim()}`);
      }
    }
    if (candidates.length > 0) return candidates.join(" | ");
    try {
      const raw = JSON.stringify(data);
      return raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
    } catch {
      return null;
    }
  }
  return null;
}

export function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  const e = err as ErrorLike;
  const parts: string[] = [];

  if (e.message) parts.push(e.message);
  if (e.code) parts.push(`code=${String(e.code)}`);
  if (e.status) parts.push(`status=${e.status}`);
  if (e.response?.status) parts.push(`http=${e.response.status}`);
  const responseData = compactResponseData(e.response?.data);
  if (responseData) parts.push(`response=${responseData}`);

  if (parts.length > 0) return parts.join(" | ");
  return "Unhandled non-error throw";
}
