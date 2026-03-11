import { PrismaClient } from "@prisma/client";

type PrismaPathSegment = string | symbol;
type PrismaPath = PrismaPathSegment[];
type PrismaProxyState = {
  path: PrismaPath;
  overrides: Map<PropertyKey, unknown>;
};

let prismaClient: PrismaClient | null = null;
const prismaProxyCache = new Map<string, unknown>();

/** Purpose: format a proxy path for diagnostics and debug output. */
function formatPrismaPath(path: PrismaPath): string {
  if (path.length === 0) return "prisma";
  return `prisma.${path.map((segment) => String(segment)).join(".")}`;
}

/** Purpose: build a stable cache key for each proxy path. */
function buildPrismaPathKey(path: PrismaPath): string {
  return path.map((segment) => String(segment)).join(".");
}

/** Purpose: normalize proxy property keys into path-safe string/symbol segments. */
function normalizePrismaPathSegment(property: PropertyKey): PrismaPathSegment {
  return typeof property === "number" ? String(property) : property;
}

/** Purpose: wrap raw Prisma initialization failures with an actionable application error. */
function buildPrismaInitializationError(error: unknown): Error {
  const detail =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  return new Error(
    [
      "Failed to initialize Prisma client.",
      "Ensure runtime configuration is loaded before first DB use.",
      "Expected prerequisites include DATABASE_URL and a generated Prisma client.",
      detail ? `Original error: ${detail}` : null,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/** Purpose: lazily create the real Prisma client only when code performs a real DB call. */
export function getPrismaClient(): PrismaClient {
  if (prismaClient) return prismaClient;
  try {
    prismaClient = new PrismaClient();
    return prismaClient;
  } catch (error) {
    throw buildPrismaInitializationError(error);
  }
}

/** Purpose: resolve a nested Prisma path into the owning object and target value. */
function resolvePrismaPath(root: unknown, path: PrismaPath): { owner: unknown; value: unknown } {
  if (path.length === 0) {
    return { owner: root, value: root };
  }

  let owner = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    owner = (owner as Record<PropertyKey, unknown>)[path[index]];
  }

  const lastSegment = path[path.length - 1];
  return {
    owner,
    value: (owner as Record<PropertyKey, unknown>)[lastSegment],
  };
}

/** Purpose: return a proxy that supports spies/mocks before the real Prisma engine is initialized. */
function createPrismaProxy(path: PrismaPath): unknown {
  const cacheKey = buildPrismaPathKey(path);
  const cached = prismaProxyCache.get(cacheKey);
  if (cached) return cached;

  const state: PrismaProxyState = {
    path: [...path],
    overrides: new Map<PropertyKey, unknown>(),
  };
  const target = function prismaProxyTarget() {
    return undefined;
  };

  const proxy = new Proxy(target, {
    get(_target, property: PropertyKey) {
      if (property === Symbol.toStringTag) return "PrismaLazyProxy";
      if (property === Symbol.for("nodejs.util.inspect.custom")) {
        return () => `[${formatPrismaPath(state.path)}]`;
      }
      if (property === "inspect" || property === "toJSON") {
        return () => `[${formatPrismaPath(state.path)}]`;
      }
      if (property === "then" && state.path.length === 0) return undefined;
      if (state.overrides.has(property)) {
        return state.overrides.get(property);
      }
      return createPrismaProxy([...state.path, normalizePrismaPathSegment(property)]);
    },
    set(_target, property: PropertyKey, value: unknown) {
      state.overrides.set(property, value);
      return true;
    },
    defineProperty(_target, property: PropertyKey, descriptor: PropertyDescriptor) {
      if ("value" in descriptor) {
        state.overrides.set(property, descriptor.value);
      }
      return true;
    },
    getOwnPropertyDescriptor(_target, property: PropertyKey) {
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: state.overrides.has(property)
          ? state.overrides.get(property)
          : createPrismaProxy([...state.path, normalizePrismaPathSegment(property)]),
      };
    },
    deleteProperty(_target, property: PropertyKey) {
      state.overrides.delete(property);
      return true;
    },
    has() {
      return true;
    },
    ownKeys() {
      return [...state.overrides.keys()].map((property) =>
        normalizePrismaPathSegment(property)
      );
    },
    apply(_target, _thisArg, argArray?: unknown[]) {
      const { owner, value } = resolvePrismaPath(getPrismaClient(), state.path);
      if (typeof value !== "function") {
        return value;
      }
      return Reflect.apply(value, owner, argArray ?? []);
    },
  });

  prismaProxyCache.set(cacheKey, proxy);
  return proxy;
}

export const prisma = createPrismaProxy([]) as PrismaClient;
