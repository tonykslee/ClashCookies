import http, { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export type HealthSnapshot = {
  checks: {
    database: "error" | "ok" | "skipped";
    discord: "not_ready" | "ok";
  };
  service: "clashcookies";
  status: "error" | "ok";
  timestamp: string;
  runtime?: {
    runtime_identity_sha256: string;
    preparation_metadata_sha256: string;
    operation_id: string;
    provenance: "application" | "fixture";
    build_sha?: string;
  };
};

type HealthcheckDependencies = {
  checkDatabase: () => Promise<void>;
  isDiscordReady: () => boolean;
  logger?: Pick<Console, "error" | "log">;
  now?: () => Date;
};

type HealthcheckConfig = {
  enabled: boolean;
  host: string;
  livePath: string;
  port: number;
  readyPath: string;
};

function normalizeBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  return fallback;
}

function normalizePort(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function normalizePath(raw: string | undefined, fallback: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

export function resolveHealthcheckConfigFromEnv(
  env: NodeJS.ProcessEnv
): HealthcheckConfig {
  return {
    enabled: normalizeBoolean(env.HEALTHCHECK_ENABLED, true),
    host: String(env.HEALTHCHECK_HOST ?? "0.0.0.0").trim() || "0.0.0.0",
    livePath: normalizePath(env.HEALTHCHECK_LIVE_PATH, "/livez"),
    port: normalizePort(env.HEALTHCHECK_PORT, 8080),
    readyPath: normalizePath(env.HEALTHCHECK_READY_PATH, "/healthz"),
  };
}

function createSnapshot(
  input: Pick<HealthSnapshot, "checks" | "status">,
  now: () => Date
): HealthSnapshot {
  return {
    checks: input.checks,
    service: "clashcookies",
    status: input.status,
    timestamp: now().toISOString(),
  };
}

export async function evaluateReadiness(
  dependencies: Pick<HealthcheckDependencies, "checkDatabase" | "isDiscordReady" | "now">
): Promise<HealthSnapshot> {
  const now = dependencies.now ?? (() => new Date());
  if (!dependencies.isDiscordReady()) {
    return createSnapshot(
      {
        checks: {
          database: "skipped",
          discord: "not_ready",
        },
        status: "error",
      },
      now
    );
  }

  try {
    await dependencies.checkDatabase();
    return createSnapshot(
      {
        checks: {
          database: "ok",
          discord: "ok",
        },
        status: "ok",
      },
      now
    );
  } catch {
    return createSnapshot(
      {
        checks: {
          database: "error",
          discord: "ok",
        },
        status: "error",
      },
      now
    );
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  snapshot: HealthSnapshot
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(snapshot)}\n`);
}

function runtimeObservationFromEnv(): HealthSnapshot["runtime"] {
  const runtimeIdentity = String(process.env.CLASHCOOKIES_RUNTIME_IDENTITY_SHA256 ?? "").trim();
  const preparationDigest = String(
    process.env.CLASHCOOKIES_PREPARATION_METADATA_SHA256 ?? "",
  ).trim();
  const operationId = String(
    process.env.CLASHCOOKIES_ACTIVATION_OPERATION_ID ?? "",
  ).trim();
  if (!runtimeIdentity || !preparationDigest || !operationId) return undefined;
  const buildSha = String(process.env.BUILD_SHA ?? "").trim();
  const provenance = process.env.CLASHCOOKIES_HEALTH_PROVENANCE === "fixture"
    ? "fixture"
    : "application";
  return {
    runtime_identity_sha256: runtimeIdentity,
    preparation_metadata_sha256: preparationDigest,
    operation_id: operationId,
    provenance,
    ...(buildSha ? { build_sha: buildSha } : {}),
  };
}

function withRuntimeObservation(snapshot: HealthSnapshot): HealthSnapshot {
  const runtime = runtimeObservationFromEnv();
  return runtime ? { ...snapshot, runtime } : snapshot;
}

export function createHealthcheckHandler(dependencies: HealthcheckDependencies) {
  const now = dependencies.now ?? (() => new Date());
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { livePath, readyPath } = resolveHealthcheckConfigFromEnv(process.env);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end("Method Not Allowed\n");
      return;
    }

    if (pathname === livePath) {
      writeJson(
        response,
        200,
        withRuntimeObservation(createSnapshot(
          {
            checks: {
              database: "skipped",
              discord: dependencies.isDiscordReady() ? "ok" : "not_ready",
            },
            status: "ok",
          },
          now
        ))
      );
      return;
    }

    if (pathname === readyPath) {
      const snapshot = await evaluateReadiness({
        checkDatabase: dependencies.checkDatabase,
        isDiscordReady: dependencies.isDiscordReady,
        now,
      });
      writeJson(
        response,
        snapshot.status === "ok" ? 200 : 503,
        withRuntimeObservation(snapshot),
      );
      return;
    }

    response.statusCode = 404;
    response.end("Not Found\n");
  };
}

export function startHealthcheckServer(dependencies: HealthcheckDependencies): void {
  const config = resolveHealthcheckConfigFromEnv(process.env);
  if (!config.enabled) return;

  const logger = dependencies.logger ?? console;
  const server = http.createServer((request, response) => {
    void createHealthcheckHandler(dependencies)(request, response).catch((error) => {
      logger.error(
        `[healthcheck] event=request_failed error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      response.end("Internal Server Error\n");
    });
  });

  server.listen(config.port, config.host, () => {
    const address = server.address() as AddressInfo | null;
    const host = address?.address ?? config.host;
    const port = address?.port ?? config.port;
    logger.log(
      `[healthcheck] event=listening host=${host} port=${port} ready_path=${config.readyPath} live_path=${config.livePath}`
    );
  });
}
