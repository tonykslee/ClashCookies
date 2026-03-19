import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { FwaStatsClient } from "../src/services/fwa-feeds/FwaStatsClient";

vi.mock("axios");

const mockedAxios = vi.mocked(axios, true);

describe("FwaStatsClient parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses Clans.json rows into normalized catalog DTOs", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [
        {
          tag: "2qg2c08up",
          name: "Rising Dawn",
          level: "30",
          points: 1234,
          requiredTrophies: "1200",
          isWarLogPublic: "true",
          th18Count: "2",
          estimatedWeight: "145000",
        },
        { tag: "", name: "" },
      ],
    } as any);

    const client = new FwaStatsClient({ retryCount: 0, timeoutMs: 1000 });
    const rows = await client.fetchClans();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clanTag: "#2QG2C08UP",
      name: "Rising Dawn",
      level: 30,
      points: 1234,
      requiredTrophies: 1200,
      isWarLogPublic: true,
      th18Count: 2,
      estimatedWeight: 145000,
    });
  });

  it("parses Members.json rows with tag/number/bool normalization", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [
        {
          tag: "abc123",
          name: "Player One",
          role: "leader",
          level: "250",
          donated: "12",
          received: "10",
          rank: "1",
          trophies: "5000",
          league: "Titan",
          townHall: "18",
          weight: "145000",
          inWar: "false",
        },
      ],
    } as any);

    const client = new FwaStatsClient({ retryCount: 0, timeoutMs: 1000 });
    const rows = await client.fetchClanMembers("#2QG2C08UP");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clanTag: "#2QG2C08UP",
      playerTag: "#ABC123",
      playerName: "Player One",
      level: 250,
      donated: 12,
      received: 10,
      rank: 1,
      trophies: 5000,
      townHall: 18,
      weight: 145000,
      inWar: false,
    });
  });

  it("parses WarMembers rows including defender fields", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [
        {
          tag: "abc123",
          name: "Player One",
          position: "3",
          townHall: "17",
          weight: "140000",
          opponentTag: "zzz999",
          opponentName: "Enemy",
          attacks: "2",
          defender1Tag: "QWE111",
          defender1Name: "Def A",
          defender1TownHall: "17",
          defender1Position: "5",
          stars1: "3",
          destructionPercentage1: "100",
          defender2Tag: "RTY222",
          defender2Name: "Def B",
          defender2TownHall: "16",
          defender2Position: "7",
          stars2: "2",
          destructionPercentage2: "80.5",
        },
      ],
    } as any);

    const client = new FwaStatsClient({ retryCount: 0, timeoutMs: 1000 });
    const rows = await client.fetchWarMembers("2QG2C08UP");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clanTag: "#2QG2C08UP",
      playerTag: "#ABC123",
      position: 3,
      townHall: 17,
      opponentTag: "#ZZZ999",
      attacks: 2,
      defender1Tag: "#QWE111",
      defender1TownHall: 17,
      stars1: 3,
      destructionPercentage2: 80.5,
    });
  });

  it("parses Wars.json rows and skips invalid rows", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [
        {
          endTime: "2026-03-19T05:00:00.000Z",
          searchTime: "2026-03-18T03:00:00.000Z",
          result: "win",
          teamSize: "50",
          clanTag: "2qg2c08up",
          clanName: "Rising Dawn",
          clanLevel: "30",
          clanStars: "95",
          clanDestructionPercentage: "98.5",
          clanAttacks: "100",
          clanExpEarned: "300",
          opponentTag: "abc999",
          opponentName: "Enemy Clan",
          opponentLevel: "25",
          opponentStars: "90",
          opponentDestructionPercentage: "95.2",
          opponentInfo: "some info",
          synced: "true",
          matched: "true",
        },
        {
          endTime: "invalid",
          teamSize: "50",
          opponentTag: "abc999",
        },
      ],
    } as any);

    const client = new FwaStatsClient({ retryCount: 0, timeoutMs: 1000 });
    const rows = await client.fetchClanWars("2QG2C08UP");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clanTag: "#2QG2C08UP",
      teamSize: 50,
      opponentTag: "#ABC999",
      synced: true,
      matched: true,
    });
    expect(rows[0].endTime.toISOString()).toBe("2026-03-19T05:00:00.000Z");
  });
});
