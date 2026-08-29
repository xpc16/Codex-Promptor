/**
 * Where the time goes when previously open conversations come back.
 *
 * Restoring one Codex conversation spawns an app-server, a PowerShell and a
 * resuming TUI, waits for the thread to load, subscribes to it and reads its
 * rollout. Any of those can dominate, and until they are measured separately
 * every claim about startup cost is a guess -- so they are measured.
 */
import { promises as fs } from "node:fs";

export type RestorePhase = { phase: string; ms: number };

export type PhaseRecorder = {
  /** Times one awaited step. Failures are timed too: a slow failure is the interesting kind. */
  step<T>(phase: string, run: () => Promise<T>): Promise<T>;
  phases(): RestorePhase[];
  totalMs(): number;
};

export function createPhaseRecorder(now: () => number = () => Date.now()): PhaseRecorder {
  const phases: RestorePhase[] = [];
  const startedAt = now();
  return {
    async step(phase, run) {
      const from = now();
      try {
        return await run();
      } finally {
        phases.push({ phase, ms: now() - from });
      }
    },
    phases: () => [...phases],
    totalMs: () => now() - startedAt,
  };
}

export type RestoreTrace = {
  tabId: string;
  name: string;
  provider: string;
  ok: boolean;
  phases: RestorePhase[];
  totalMs: number;
};

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * One line per conversation, slowest first, because the slowest is the one
 * worth attacking and the phase split says what to attack.
 */
export function formatRestoreTimings(traces: readonly RestoreTrace[], wallMs: number, staggerMs: number): string[] {
  if (!traces.length) return [];
  const sorted = [...traces].sort((left, right) => right.totalMs - left.totalMs);
  const width = Math.max(...sorted.map((trace) => trace.name.length));
  return [
    `Restore timings: ${traces.length} conversation(s) in ${formatDuration(wallMs)}, launched ${staggerMs}ms apart`,
    ...sorted.map((trace) => {
      const phases = trace.phases.map((phase) => `${phase.phase} ${formatDuration(phase.ms)}`).join(" · ");
      const failed = trace.ok ? "" : " [failed]";
      return `  ${formatDuration(trace.totalMs).padStart(7)}  ${trace.provider.padEnd(6)} ${trace.name.padEnd(width)}  ${phases}${failed}`;
    }),
  ];
}

/** Keeps this many lines, which is a few dozen launches -- enough to compare two builds. */
const TIMING_LOG_LINES = 400;

/**
 * Startup timings are only useful if they outlive the console they were printed
 * to. The first version of this wrote nowhere, so the one question it existed to
 * answer -- did a change make startup faster -- still could not be checked.
 */
export async function appendRestoreTimings(file: string, lines: readonly string[]): Promise<void> {
  if (!lines.length) return;
  try {
    const previous = await fs.readFile(file, "utf8").catch(() => "");
    const kept = [...previous.split("\n").filter(Boolean), `[${new Date().toISOString()}]`, ...lines];
    await fs.writeFile(file, `${kept.slice(-TIMING_LOG_LINES).join("\n")}\n`, "utf8");
  } catch { /* a diagnostic that cannot be written must never break a launch */ }
}
