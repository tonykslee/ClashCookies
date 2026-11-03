export type CompoRefreshMode = "actual" | "war";

export type CompoRefreshGuardDecision =
  | {
      accepted: true;
      mode: CompoRefreshMode;
      startedAt: number;
      availableAt: number;
    }
  | {
      accepted: false;
      mode: CompoRefreshMode;
      reason: "busy" | "cooldown";
      availableAt: number;
    };

type CompoRefreshGuardState = {
  inFlight: boolean;
  cooldownUntil: number;
};

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Purpose: serialize process-local compo refreshes and rate-limit their shared upstream scopes. */
export class CompoRefreshGuard {
  private readonly states: Record<CompoRefreshMode, CompoRefreshGuardState> = {
    actual: { inFlight: false, cooldownUntil: 0 },
    war: { inFlight: false, cooldownUntil: 0 },
  };

  constructor(
    private readonly options: {
      clock?: () => number;
      cooldownMs?: number;
    } = {},
  ) {}

  tryStart(mode: CompoRefreshMode): CompoRefreshGuardDecision {
    const now = this.now();
    const state = this.states[mode];
    if (state.inFlight) {
      return {
        accepted: false,
        mode,
        reason: "busy",
        availableAt: state.cooldownUntil,
      };
    }
    if (state.cooldownUntil > now) {
      return {
        accepted: false,
        mode,
        reason: "cooldown",
        availableAt: state.cooldownUntil,
      };
    }

    state.inFlight = true;
    state.cooldownUntil = now + this.cooldownMs();
    return {
      accepted: true,
      mode,
      startedAt: now,
      availableAt: state.cooldownUntil,
    };
  }

  finish(mode: CompoRefreshMode): void {
    this.states[mode].inFlight = false;
  }

  reset(): void {
    for (const state of Object.values(this.states)) {
      state.inFlight = false;
      state.cooldownUntil = 0;
    }
  }

  private now(): number {
    const value = this.options.clock?.() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  }

  private cooldownMs(): number {
    const value = this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COOLDOWN_MS;
  }
}

export const compoRefreshGuard = new CompoRefreshGuard();

export const resetCompoRefreshGuardForTest = (): void => {
  compoRefreshGuard.reset();
};
