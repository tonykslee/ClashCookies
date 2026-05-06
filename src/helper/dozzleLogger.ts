import { format } from "node:util";

export type DozzleLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const CONSOLE_METHOD_BY_LEVEL: Record<DozzleLogLevel, "log" | "debug" | "info" | "warn" | "error"> = {
  trace: "log",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  fatal: "error",
};

export const dozzleConsoleSink: Record<"log" | "debug" | "info" | "warn" | "error", (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let dozzleConsoleInstalled = false;

/** Purpose: prefix an app-owned log line with a Dozzle-recognizable level token. */
export function formatDozzleLogLine(level: DozzleLogLevel, message: string): string {
  const normalized = String(message ?? "").trim();
  return normalized ? `[${level}] ${normalized}` : `[${level}]`;
}

/** Purpose: write one app-owned log line using a standard Dozzle level token. */
export function logDozzle(level: DozzleLogLevel, message: string, ...args: unknown[]): void {
  const line = args.length > 0 ? format(message, ...args) : String(message ?? "");
  dozzleConsoleSink[CONSOLE_METHOD_BY_LEVEL[level]](formatDozzleLogLine(level, line));
}

/** Purpose: normalize console output so app-owned logs stay Dozzle-filterable. */
export function installDozzleConsole(): () => void {
  if (dozzleConsoleInstalled) {
    return () => undefined;
  }
  dozzleConsoleInstalled = true;

  console.log = ((...args: unknown[]) => {
    dozzleConsoleSink.log(formatDozzleLogLine("info", args.length > 0 ? format(...args) : ""));
  }) as typeof console.log;
  console.debug = ((...args: unknown[]) => {
    dozzleConsoleSink.debug(formatDozzleLogLine("debug", args.length > 0 ? format(...args) : ""));
  }) as typeof console.debug;
  console.info = ((...args: unknown[]) => {
    dozzleConsoleSink.info(formatDozzleLogLine("info", args.length > 0 ? format(...args) : ""));
  }) as typeof console.info;
  console.warn = ((...args: unknown[]) => {
    dozzleConsoleSink.warn(formatDozzleLogLine("warn", args.length > 0 ? format(...args) : ""));
  }) as typeof console.warn;
  console.error = ((...args: unknown[]) => {
    dozzleConsoleSink.error(formatDozzleLogLine("error", args.length > 0 ? format(...args) : ""));
  }) as typeof console.error;

  return () => {
    if (!dozzleConsoleInstalled) {
      return;
    }
    console.log = dozzleConsoleSink.log as typeof console.log;
    console.debug = dozzleConsoleSink.debug as typeof console.debug;
    console.info = dozzleConsoleSink.info as typeof console.info;
    console.warn = dozzleConsoleSink.warn as typeof console.warn;
    console.error = dozzleConsoleSink.error as typeof console.error;
    dozzleConsoleInstalled = false;
  };
}

export const dozzleLog = {
  trace: (message: string, ...args: unknown[]) => logDozzle("trace", message, ...args),
  debug: (message: string, ...args: unknown[]) => logDozzle("debug", message, ...args),
  info: (message: string, ...args: unknown[]) => logDozzle("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => logDozzle("warn", message, ...args),
  error: (message: string, ...args: unknown[]) => logDozzle("error", message, ...args),
  fatal: (message: string, ...args: unknown[]) => logDozzle("fatal", message, ...args),
} as const;
