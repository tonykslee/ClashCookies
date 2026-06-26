import { describe, expect, it } from "vitest";
import {
  buildTrackedWarMemberStateByClanAndPlayer,
  type TodoTrackedCurrentWarRow,
  type TodoTrackedWarAttackRow,
  type TodoTrackedWarRosterRow,
} from "../src/services/TodoTrackedWarStateService";

function makeCurrentWar(
  overrides: Partial<TodoTrackedCurrentWarRow> = {},
): TodoTrackedCurrentWarRow {
  return {
    clanTag: "#PQL0289",
    warId: 1001,
    startTime: new Date("2026-03-25T12:00:00.000Z"),
    state: "inWar",
    updatedAt: new Date("2026-03-26T00:00:00.000Z"),
    ...overrides,
  };
}

function makeRosterRow(
  overrides: Partial<TodoTrackedWarRosterRow> = {},
): TodoTrackedWarRosterRow {
  return {
    clanTag: "#PQL0289",
    playerTag: "#PYLQ0289",
    position: 8,
    playerName: "Alpha",
    townHall: 15,
    ...overrides,
  };
}

function makeAttackRow(
  overrides: Partial<TodoTrackedWarAttackRow> = {},
): TodoTrackedWarAttackRow {
  return {
    warId: 1001,
    clanTag: "#PQL0289",
    warStartTime: new Date("2026-03-25T12:00:00.000Z"),
    playerTag: "#PYLQ0289",
    playerPosition: 8,
    attacksUsed: 1,
    attackOrder: 1,
    attackNumber: 1,
    defenderPosition: 7,
    stars: 3,
    attackSeenAt: new Date("2026-03-26T00:10:00.000Z"),
    ...overrides,
  };
}

describe("TodoTrackedWarStateService", () => {
  it("accepts active exact attack rows and marks them as exact attack state", () => {
    const rows = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: new Map([["#PQL0289", makeCurrentWar()]]),
      rosterRows: [makeRosterRow()],
      warAttackRows: [makeAttackRow()],
    });

    const member = rows.get("#PQL0289:#PYLQ0289");
    expect(member).toEqual(
      expect.objectContaining({
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        attacksUsed: 1,
        hasExactAttackState: true,
      }),
    );
  });

  it("accepts retained-ended exact contexts only when explicitly marked", () => {
    const rows = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: new Map([
        [
          "#PQL0289",
          makeCurrentWar({
            warId: 2002,
            startTime: new Date("2026-03-24T12:00:00.000Z"),
            state: "finished",
            renderState: "RETAINED_ENDED",
          }),
        ],
      ]),
      rosterRows: [makeRosterRow()],
      warAttackRows: [
        makeAttackRow({
          warId: 2002,
          warStartTime: new Date("2026-03-24T12:00:00.000Z"),
          attacksUsed: 2,
        }),
      ],
    });

    const member = rows.get("#PQL0289:#PYLQ0289");
    expect(member).toEqual(
      expect.objectContaining({
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        attacksUsed: 2,
        hasExactAttackState: true,
      }),
    );
  });

  it("rejects finished contexts without retained-ended eligibility", () => {
    const rows = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: new Map([
        [
          "#PQL0289",
          makeCurrentWar({
            warId: 2002,
            startTime: new Date("2026-03-24T12:00:00.000Z"),
            state: "finished",
          }),
        ],
      ]),
      rosterRows: [makeRosterRow()],
      warAttackRows: [
        makeAttackRow({
          warId: 2002,
          warStartTime: new Date("2026-03-24T12:00:00.000Z"),
          attacksUsed: 2,
        }),
      ],
    });

    expect(rows.size).toBe(0);
  });

  it("does not let attack rows invent ownership or previous-war authority", () => {
    const previousWarRows = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: new Map([["#PQL0289", makeCurrentWar({ warId: 2002 })]]),
      rosterRows: [makeRosterRow()],
      warAttackRows: [
        makeAttackRow({
          warId: 1001,
          warStartTime: new Date("2026-03-25T12:00:00.000Z"),
          attacksUsed: 2,
        }),
      ],
    });
    const attackOnlyRows = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: new Map([["#PQL0289", makeCurrentWar()]]),
      rosterRows: [],
      warAttackRows: [makeAttackRow()],
    });

    expect(previousWarRows.get("#PQL0289:#PYLQ0289")).toEqual(
      expect.objectContaining({
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        attacksUsed: 0,
        hasExactAttackState: false,
      }),
    );
    expect(attackOnlyRows.size).toBe(0);
  });
});
