import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dozzleConsoleSink,
  dozzleLog,
  formatDozzleLogLine,
  installDozzleConsole,
} from "../src/helper/dozzleLogger";

describe("dozzleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats app-owned lines with a Dozzle-recognizable level token", () => {
    expect(formatDozzleLogLine("info", "startup complete")).toBe("[info] startup complete");
    expect(formatDozzleLogLine("warn", "  ")).toBe("[warn]");
  });

  it("routes helper logs through the matching level sink", () => {
    const infoSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);

    dozzleLog.info("startup %s", "ready");

    expect(infoSpy).toHaveBeenCalledWith("[info] startup ready");
  });

  it("prefixes console output after the shim is installed", () => {
    const restore = installDozzleConsole();
    const warnSpy = vi.spyOn(dozzleConsoleSink, "warn").mockImplementation(() => undefined);
    try {
      console.warn("queued %s", "delay");

      expect(warnSpy).toHaveBeenCalledWith("[warn] queued delay");
    } finally {
      restore();
    }
  });
});
