import { DEFAULT_A2A_SKILL, type A2aPromptMeta } from "./a2a.js";

/**
 * `@@` is read once, on the server, where the user's queue text arrives --
 * not in the browser and not in the TUI, so every entry point that stores a
 * prompt agrees on what was asked (docs/AGENT_TO_AGENT.md 4.1). The composer
 * shares this module so the prefix it shows back is the one that was parsed.
 */

export type PromptPrefix =
  | { kind: "a2a"; skill: string; text: string }
  | { kind: "plain"; text: string };

export class A2aPrefixError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "A2aPrefixError";
  }
}

const NAMED = /^@@([a-z0-9_-]+)(?:[ \t]+|\r?\n|$)([\s\S]*)$/;
const BARE = /^@@[ \t]*\r?\n?([\s\S]*)$/;

/**
 * `\@@` is how a prompt starts with a literal `@@`. Everything else that does
 * not start with `@@` is returned untouched, including text that merely
 * contains one.
 */
export function parsePromptPrefix(raw: string): PromptPrefix {
  const text = raw.trimStart();
  if (text.startsWith("\\@@")) return { kind: "plain", text: text.slice(1) };
  if (!text.startsWith("@@")) return { kind: "plain", text: raw };
  const named = NAMED.exec(text);
  if (named) {
    const body = named[2].trim();
    if (!body) throw new A2aPrefixError("A2A_PROMPT_EMPTY", "@@ 后面需要写清楚要协作完成的事。");
    return { kind: "a2a", skill: named[1], text: body };
  }
  const bare = BARE.exec(text);
  const body = (bare?.[1] ?? "").trim();
  if (!body) throw new A2aPrefixError("A2A_PROMPT_EMPTY", "@@ 后面需要写清楚要协作完成的事。");
  return { kind: "a2a", skill: DEFAULT_A2A_SKILL, text: body };
}

/**
 * What the composer should show when a stored prompt is edited: the prefix is
 * rebuilt from the metadata, not from the text, and a plain prompt that merely
 * begins with `@@` is re-escaped so saving it again does not start a
 * collaboration nobody asked for.
 */
export function restorePromptPrefix(text: string, meta?: A2aPromptMeta | null): string {
  if (meta) return `@@${meta.skill} ${text}`;
  return text.startsWith("@@") ? `\\${text}` : text;
}
