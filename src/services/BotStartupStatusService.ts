import { formatError } from "../helper/formatError";

export type BotStartupStatusSnapshot = {
  status: "starting" | "online" | "failed";
  phase: string;
  startedAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
};

const MAX_ERROR_LENGTH = 900;

const state: BotStartupStatusSnapshot = {
  status: "starting",
  phase: "booting",
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  lastError: null,
  metadata: null,
};

function cloneSnapshot(): BotStartupStatusSnapshot {
  return {
    status: state.status,
    phase: state.phase,
    startedAt: state.startedAt ? new Date(state.startedAt) : null,
    updatedAt: state.updatedAt ? new Date(state.updatedAt) : null,
    completedAt: state.completedAt ? new Date(state.completedAt) : null,
    lastError: state.lastError,
    metadata: state.metadata ? { ...state.metadata } : null,
  };
}

function normalizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  return { ...metadata };
}

function truncateErrorText(error: unknown): string {
  const text = formatError(error).trim();
  if (text.length <= MAX_ERROR_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_LENGTH - 12)}...truncated`;
}

function markStartedIfNeeded(now: Date): void {
  if (!state.startedAt) {
    state.startedAt = now;
  }
}

export class BotStartupStatusService {
  markPhase(phase: string, metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    markStartedIfNeeded(now);
    state.status = "starting";
    state.phase = String(phase ?? "").trim() || state.phase;
    state.updatedAt = now;
    state.metadata = normalizeMetadata(metadata);
    return cloneSnapshot();
  }

  markComplete(metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    markStartedIfNeeded(now);
    state.status = "online";
    state.phase = "complete";
    state.updatedAt = now;
    state.completedAt = now;
    state.metadata = normalizeMetadata(metadata);
    return cloneSnapshot();
  }

  markFailed(error: unknown, metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    markStartedIfNeeded(now);
    state.status = "failed";
    state.phase = "failed";
    state.updatedAt = now;
    state.completedAt = now;
    state.lastError = truncateErrorText(error);
    state.metadata = normalizeMetadata(metadata);
    return cloneSnapshot();
  }

  getSnapshot(): BotStartupStatusSnapshot {
    return cloneSnapshot();
  }
}

export const botStartupStatusService = new BotStartupStatusService();
