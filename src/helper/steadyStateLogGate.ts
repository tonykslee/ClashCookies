export type SteadyStateLogLevel = "info" | "debug";

/** Purpose: track last-emitted signatures and suppress repeated steady-state info logs. */
export class SteadyStateLogGate {
  private readonly lastSignatureByIdentity = new Map<string, string>();

  /** Purpose: initialize bounded in-memory signature storage for logging-only dedupe. */
  constructor(private readonly maxIdentities: number = 2000) {}

  /** Purpose: return true when the identity's signature is new or changed since last emit. */
  shouldEmitInfo(identity: string, signature: string): boolean {
    const normalizedIdentity = identity.trim();
    const normalizedSignature = signature.trim();
    const previous = this.lastSignatureByIdentity.get(normalizedIdentity);
    if (previous === normalizedSignature) return false;
    this.lastSignatureByIdentity.set(normalizedIdentity, normalizedSignature);
    this.pruneOverflow();
    return true;
  }

  /** Purpose: clear tracked signatures for deterministic tests or lifecycle resets. */
  clear(): void {
    this.lastSignatureByIdentity.clear();
  }

  /** Purpose: evict oldest identities to keep log-only dedupe memory bounded. */
  private pruneOverflow(): void {
    while (this.lastSignatureByIdentity.size > this.maxIdentities) {
      const oldestKey = this.lastSignatureByIdentity.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.lastSignatureByIdentity.delete(oldestKey);
    }
  }
}

/** Purpose: classify steady-state logs into info for changes and debug for repeats. */
export function resolveSteadyStateLogLevel(params: {
  gate: SteadyStateLogGate;
  identity: string;
  signature: string;
}): SteadyStateLogLevel {
  return params.gate.shouldEmitInfo(params.identity, params.signature)
    ? "info"
    : "debug";
}
