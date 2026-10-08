import { defineConfig } from "vitest/config";

// Database-backed suites: every test file creates (and drops) its own
// Postgres database in tests/helpers/harness.ts, so files are isolated.
// Concurrency *inside* a test is real: parallel requests over separate
// sockets and pooled connections.
const dbProject = (name: string, include: string[], timeout = 30_000) => ({
  test: {
    name,
    include,
    testTimeout: timeout,
    hookTimeout: 30_000,
    setupFiles: ["tests/helpers/setup-env.ts"],
  },
});

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      dbProject("integration", ["tests/integration/**/*.test.ts"]),
      dbProject("concurrency", ["tests/concurrency/**/*.test.ts"], 60_000),
      dbProject("invariants", ["tests/invariants/**/*.test.ts", "tests/property/**/*.test.ts"], 180_000),
    ],
  },
});
