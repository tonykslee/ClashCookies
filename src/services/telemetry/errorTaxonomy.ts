export type TelemetryErrorCategory =
  | "permission"
  | "validation"
  | "timeout"
  | "discord_api"
  | "upstream_api"
  | "network"
  | "internal";

export type TelemetryErrorInfo = {
  category: TelemetryErrorCategory;
  code: string;
  timeout: boolean;
};

/** Purpose: classify unknown errors into stable telemetry categories and codes. */
export function classifyTelemetryError(error: unknown): TelemetryErrorInfo {
  const codeRaw = (error as { code?: unknown } | null | undefined)?.code;
  const code = typeof codeRaw === "string" || typeof codeRaw === "number" ? String(codeRaw) : "";
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? "");
  const statusRaw =
    (error as { status?: unknown } | null | undefined)?.status ??
    (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  const status =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && /^\d+$/.test(statusRaw)
        ? Number(statusRaw)
        : null;

  const msg = message.toLowerCase();
  const timeout =
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    msg.includes("timeout") ||
    msg.includes("timed out");
  if (timeout) {
    return { category: "timeout", code: code || "TIMEOUT", timeout: true };
  }

  if (code === "50013" || code === "50001" || msg.includes("missing permissions")) {
    return { category: "permission", code: code || "DISCORD_PERMISSION", timeout: false };
  }

  if (status !== null && status >= 400 && status < 500) {
    return {
      category: status === 401 || status === 403 ? "permission" : "validation",
      code: `HTTP_${status}`,
      timeout: false,
    };
  }

  if (status !== null && status >= 500) {
    return { category: "upstream_api", code: `HTTP_${status}`, timeout: false };
  }

  if (code === "10062" || code === "40060" || code === "50035") {
    return { category: "discord_api", code, timeout: false };
  }

  if (
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    msg.includes("network")
  ) {
    return { category: "network", code: code || "NETWORK_ERROR", timeout: false };
  }

  return { category: "internal", code: code || "INTERNAL_ERROR", timeout: false };
}
