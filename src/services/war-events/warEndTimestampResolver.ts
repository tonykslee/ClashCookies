/** Purpose: identify the small set of source observations eligible for canonical war-end authority. */
export type WarEndTimestampObservationSource = "CURRENT_WAR" | "WAR_ATTACKS" | "WAR_LOG";

/** Purpose: describe the bounded evidence state returned by the timestamp resolver. */
export type WarEndTimestampEvidenceStatus = "VERIFIED" | "UNKNOWN" | "CONFLICTING";

/** Purpose: keep timestamp-resolution diagnostics stable for logs and tests. */
export type WarEndTimestampReasonCode =
  | "CURRENT_WAR_CORROBORATED"
  | "WAR_ATTACKS_FALLBACK"
  | "NO_EXACT_DIRECT_API_OBSERVATION"
  | "CURRENT_WAR_UNCORROBORATED"
  | "CONFLICTING_WAR_ATTACKS"
  | "CURRENT_WAR_CONFLICTS_WITH_WAR_ATTACKS"
  | "MALFORMED_WAR_ATTACK_TIMESTAMP";

/** Purpose: carry one already identity-checked source observation into the pure resolver. */
export type WarEndTimestampObservation = {
  source: WarEndTimestampObservationSource;
  timestamp: Date | null;
  exactWar: boolean;
  directApiObserved: boolean;
};

/** Purpose: return the selected canonical timestamp and its bounded provenance decision. */
export type WarEndTimestampDecision = {
  timestamp: Date | null;
  source: "CURRENT_WAR" | "WAR_ATTACKS" | "UNKNOWN";
  evidenceStatus: WarEndTimestampEvidenceStatus;
  reasonCode: WarEndTimestampReasonCode;
};

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

/** Purpose: resolve one canonical end timestamp without proximity, fallback, or source invention. */
export function resolveCanonicalWarEndTimestamp(input: {
  observations: readonly WarEndTimestampObservation[];
}): WarEndTimestampDecision {
  const exactAttackObservations = input.observations.filter(
    (observation) =>
      observation.source === "WAR_ATTACKS" && observation.exactWar && observation.directApiObserved,
  );
  const malformedExactAttack = input.observations.some(
    (observation) =>
      observation.source === "WAR_ATTACKS" &&
      observation.exactWar &&
      observation.directApiObserved &&
      !isValidDate(observation.timestamp),
  );
  if (malformedExactAttack) {
    return {
      timestamp: null,
      source: "UNKNOWN",
      evidenceStatus: "UNKNOWN",
      reasonCode: "MALFORMED_WAR_ATTACK_TIMESTAMP",
    };
  }

  const attackTimestamps = [
    ...new Map(
      exactAttackObservations
        .filter((observation): observation is WarEndTimestampObservation & { timestamp: Date } =>
          isValidDate(observation.timestamp),
        )
        .map((observation) => [observation.timestamp.getTime(), observation.timestamp]),
    ).values(),
  ];
  if (attackTimestamps.length > 1) {
    return {
      timestamp: null,
      source: "UNKNOWN",
      evidenceStatus: "CONFLICTING",
      reasonCode: "CONFLICTING_WAR_ATTACKS",
    };
  }
  if (attackTimestamps.length === 0) {
    const hasExactCurrentWar = input.observations.some(
      (observation) => observation.source === "CURRENT_WAR" && observation.exactWar,
    );
    return {
      timestamp: null,
      source: "UNKNOWN",
      evidenceStatus: "UNKNOWN",
      reasonCode: hasExactCurrentWar
        ? "CURRENT_WAR_UNCORROBORATED"
        : "NO_EXACT_DIRECT_API_OBSERVATION",
    };
  }

  const attackTimestamp = attackTimestamps[0];
  const currentWarObservation = input.observations.find(
    (observation): observation is WarEndTimestampObservation & { timestamp: Date } =>
      observation.source === "CURRENT_WAR" &&
      observation.exactWar &&
      isValidDate(observation.timestamp),
  );
  if (currentWarObservation) {
    if (!sameInstant(currentWarObservation.timestamp, attackTimestamp)) {
      return {
        timestamp: null,
        source: "UNKNOWN",
        evidenceStatus: "CONFLICTING",
        reasonCode: "CURRENT_WAR_CONFLICTS_WITH_WAR_ATTACKS",
      };
    }
    return {
      timestamp: attackTimestamp,
      source: "CURRENT_WAR",
      evidenceStatus: "VERIFIED",
      reasonCode: "CURRENT_WAR_CORROBORATED",
    };
  }

  return {
    timestamp: attackTimestamp,
    source: "WAR_ATTACKS",
    evidenceStatus: "VERIFIED",
    reasonCode: "WAR_ATTACKS_FALLBACK",
  };
}
