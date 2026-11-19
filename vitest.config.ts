import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    threads: true,
    minThreads: 1,
    maxThreads: 2,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});

