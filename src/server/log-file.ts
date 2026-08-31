import { promises as fs } from "node:fs";

/**
 * Appends to a small rolling log file, keeping the most recent lines.
 *
 * Diagnostics that outlive the console they were printed to. The restore
 * timings were printed and nowhere else, so the one question they existed to
 * answer could not be checked afterwards; the same is true of anything written
 * while a turn is going wrong.
 */
export async function appendBoundedLines(file: string, lines: readonly string[], maxLines: number): Promise<void> {
  if (!lines.length) return;
  try {
    const previous = await fs.readFile(file, "utf8").catch(() => "");
    const kept = [...previous.split("\n").filter(Boolean), `[${new Date().toISOString()}]`, ...lines];
    await fs.writeFile(file, `${kept.slice(-maxLines).join("\n")}\n`, "utf8");
  } catch { /* a diagnostic that cannot be written must never break what it observes */ }
}
