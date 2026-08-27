import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Several server suites boot a real Fastify app and wait on real timers
    // with ~5s deadlines. Letting one file per core run at once (16 here)
    // starved those waits, so they failed at the deadline rather than on an
    // assertion. Two workers trades ~6s of wall clock for a suite that
    // actually passes every run.
    maxWorkers: 2,
  },
});
