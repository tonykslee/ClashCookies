import { describe, expect, it } from "vitest";
import {
  buildActiveWarRemainingSamples,
  formatCurrentWarPhaseLabel,
  formatHumanDuration,
  formatMinutesSeconds,
  getCurrentWarPhase,
  getPhaseEndAtMs,
  normalizeClanTag,
} from "../src/services/RemainingWarService";

describe("remaining war helper logic", () => {
  it("normalizes current-war clan tags with a leading hash", () => {
    expect(normalizeClanTag("ab12c")).toBe("#AB12C");
    expect(normalizeClanTag(" #ab12c ")).toBe("#AB12C");
    expect(normalizeClanTag("")).toBe("");
  });

  it("maps persisted war states to supported phase values", () => {
    expect(getCurrentWarPhase("preparation")).toBe("preparation");
    expect(getCurrentWarPhase(" inWar ")).toBe("inWar");
    expect(getCurrentWarPhase("warEnded")).toBeNull();
  });

  it("chooses prep end for preparation rows and war end for battle-day rows", () => {
    const prepStart = new Date("2026-03-19T18:00:00.000Z");
    const warEnd = new Date("2026-03-20T18:00:00.000Z");

    expect(
      getPhaseEndAtMs({
        clanTag: "#AAA111",
        state: "preparation",
        startTime: prepStart,
        endTime: warEnd,
      })
    ).toBe(prepStart.getTime());

    expect(
      getPhaseEndAtMs({
        clanTag: "#AAA111",
        state: "inWar",
        startTime: prepStart,
        endTime: warEnd,
      })
    ).toBe(warEnd.getTime());
  });

  it("builds sorted active-war samples and skips invalid rows", () => {
    const nowMs = Date.parse("2026-03-19T12:00:00.000Z");
    const samples = buildActiveWarRemainingSamples(
      [
        {
          clanTag: "bbb222",
          state: "inWar",
          startTime: new Date("2026-03-19T00:00:00.000Z"),
          endTime: new Date("2026-03-19T13:00:00.000Z"),
        },
        {
          clanTag: "#AAA111",
          state: "preparation",
          startTime: new Date("2026-03-19T12:15:30.000Z"),
          endTime: new Date("2026-03-20T12:15:30.000Z"),
        },
        {
          clanTag: "#DROP",
          state: "warEnded",
          startTime: new Date("2026-03-19T12:00:00.000Z"),
          endTime: new Date("2026-03-19T13:00:00.000Z"),
        },
      ],
      new Map([
        ["#AAA111", "Alpha"],
        ["#BBB222", "Bravo"],
      ]),
      nowMs
    );

    expect(samples).toEqual([
      {
        clanTag: "#AAA111",
        clanName: "Alpha",
        phase: "preparation",
        phaseEndAtMs: Date.parse("2026-03-19T12:15:30.000Z"),
        remainingSeconds: 930,
        remainingMinutes: 15,
      },
      {
        clanTag: "#BBB222",
        clanName: "Bravo",
        phase: "inWar",
        phaseEndAtMs: Date.parse("2026-03-19T13:00:00.000Z"),
        remainingSeconds: 3600,
        remainingMinutes: 60,
      },
    ]);
  });

  it("formats compact and human-readable durations for output lines", () => {
    expect(formatMinutesSeconds(125)).toBe("2m5s");
    expect(formatMinutesSeconds(-1)).toBe("0m0s");
    expect(formatHumanDuration(3661)).toBe("1h 1m 1s");
    expect(formatHumanDuration(59)).toBe("0m 59s");
    expect(formatCurrentWarPhaseLabel("preparation")).toBe("Preparation Day");
    expect(formatCurrentWarPhaseLabel("inWar")).toBe("Battle Day");
  });
});
