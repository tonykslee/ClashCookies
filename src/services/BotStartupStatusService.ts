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

function normalizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  return { ...metadata };
}

function truncateErrorText(error: unknown): string {
  const text = formatError(error).trim();
  if (text.length <= MAX_ERROR_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_LENGTH - 12)}...truncated`;
}

export class BotStartupStatusService {
  private readonly state: BotStartupStatusSnapshot = {
    status: "starting",
    phase: "booting",
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    lastError: null,
    metadata: null,
  };

  private cloneSnapshot(): BotStartupStatusSnapshot {
    return {
      status: this.state.status,
      phase: this.state.phase,
      startedAt: this.state.startedAt ? new Date(this.state.startedAt) : null,
      updatedAt: this.state.updatedAt ? new Date(this.state.updatedAt) : null,
      completedAt: this.state.completedAt ? new Date(this.state.completedAt) : null,
      lastError: this.state.lastError,
      metadata: this.state.metadata ? { ...this.state.metadata } : null,
    };
  }

  private markStartedIfNeeded(now: Date): void {
    if (!this.state.startedAt) {
      this.state.startedAt = now;
    }
  }

  markPhase(phase: string, metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    const normalizedPhase = String(phase ?? "").trim() || this.state.phase;
    if (normalizedPhase === "ready_start") {
      this.state.startedAt = now;
      this.state.completedAt = null;
      this.state.lastError = null;
    } else {
      this.markStartedIfNeeded(now);
    }
    this.state.status = "starting";
    this.state.phase = normalizedPhase;
    this.state.updatedAt = now;
    this.state.metadata = normalizeMetadata(metadata);
    return this.cloneSnapshot();
  }

  markComplete(metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    this.markStartedIfNeeded(now);
    this.state.status = "online";
    this.state.phase = "complete";
    this.state.updatedAt = now;
    this.state.completedAt = now;
    this.state.metadata = normalizeMetadata(metadata);
    return this.cloneSnapshot();
  }

  markFailed(error: unknown, metadata?: Record<string, unknown>): BotStartupStatusSnapshot {
    const now = new Date();
    this.markStartedIfNeeded(now);
    this.state.status = "failed";
    this.state.phase = "failed";
    this.state.updatedAt = now;
    this.state.completedAt = now;
    this.state.lastError = truncateErrorText(error);
    this.state.metadata = normalizeMetadata(metadata);
    return this.cloneSnapshot();
  }

  getSnapshot(): BotStartupStatusSnapshot {
    return this.cloneSnapshot();
  }
}

export const botStartupStatusService = new BotStartupStatusService();
