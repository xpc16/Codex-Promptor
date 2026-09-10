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
 * What an edited prompt becomes, decided from the prompt that is stored.
 *
 * The row sends exactly what its textarea holds, with no prefix bookkeeping
 * of its own -- a browser tab left open across an upgrade would otherwise
 * still be speaking the previous convention, and the disagreement is silent:
 * a collaboration someone asked for just quietly runs as ordinary text.
 *
 * Two facts about the stored prompt settle it. One that is already a
 * collaboration stays one. One whose own text already begins with `@@` was
 * written that way on purpose and stays literal. Anything else is read as
 * typed -- which is what makes "put @@ in front of a queued prompt" work.
 */
export function editedPromptPrefix(
  stored: { text: string; a2a?: A2aPromptMeta | null },
  incoming: string,
): PromptPrefix {
  const parsed = parsePromptPrefix(incoming);
  if (stored.a2a) {
    // A prefix may still name a different mode; without one the body is taken
    // as typed and the collaboration keeps the mode it already had.
    return { kind: "a2a", skill: parsed.kind === "a2a" ? parsed.skill : stored.a2a.skill, text: parsed.text };
  }
  if (stored.text.startsWith("@@")) {
    return { kind: "plain", text: parsed.kind === "a2a" ? incoming.trim() : parsed.text };
  }
  return parsed;
}
