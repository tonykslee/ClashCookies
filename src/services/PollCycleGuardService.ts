type PollCycleLogger = Pick<Console, "warn">;

/** Purpose: prevent one scheduled job from running concurrently with itself. */
export class PollCycleGuardService {
  private readonly inProgress = new Set<string>();

  constructor(private readonly logger: PollCycleLogger = console) {}

  /** Purpose: run one job only when no prior cycle is still active; otherwise skip/coalesce. */
  async run<T>(job: string, execute: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const key = String(job ?? "").trim() || "unknown";
    if (this.inProgress.has(key)) {
      this.logger.warn(`[poll-cycle] event=overlap_skipped job=${key}`);
      return { ran: false };
    }

    this.inProgress.add(key);
    try {
      const value = await execute();
      return { ran: true, value };
    } finally {
      this.inProgress.delete(key);
    }
  }

  /** Purpose: expose current guard state for tests and diagnostics. */
  isRunning(job: string): boolean {
    const key = String(job ?? "").trim() || "unknown";
    return this.inProgress.has(key);
  }
}

