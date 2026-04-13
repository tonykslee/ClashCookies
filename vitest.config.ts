import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    threads: true,
    singleThread: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});

