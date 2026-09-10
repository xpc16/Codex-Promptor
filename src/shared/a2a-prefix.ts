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
 * Read the `@@` prefix, and leave it in place.
 *
 * `text` is what gets stored, prefix and all: the reader wrote it, so the
 * queue shows it back. Only the mode name is extracted, and only the empty
 * case is refused. `\@@` remains the way to write a prompt that merely starts
 * with those two characters.
 */
export function parsePromptPrefix(raw: string): PromptPrefix {
  const text = raw.trim();
  if (text.startsWith("\\@@")) return { kind: "plain", text: text.slice(1) };
  if (!text.startsWith("@@")) return { kind: "plain", text: raw.trim() };
  const named = NAMED.exec(text);
  if (named) {
    if (!named[2].trim()) throw new A2aPrefixError("A2A_PROMPT_EMPTY", "@@ 后面需要写清楚要协作完成的事。");
    return { kind: "a2a", skill: named[1], text };
  }
  const bare = BARE.exec(text);
  if (!(bare?.[1] ?? "").trim()) throw new A2aPrefixError("A2A_PROMPT_EMPTY", "@@ 后面需要写清楚要协作完成的事。");
  return { kind: "a2a", skill: DEFAULT_A2A_SKILL, text };
}

/**
 * What an edited prompt becomes.
 *
 * With the prefix left in the text, the text is the whole answer: it starts
 * with `@@` or it does not, and editing it either way is the reader saying so.
 * The one exception is a message that arrived from another conversation --
 * that never carried a prefix, and removing one it never had must not drop it
 * out of the collaboration it belongs to.
 */
export function editedPromptPrefix(
  stored: { text: string; a2a?: A2aPromptMeta | null },
  incoming: string,
): PromptPrefix {
  if (stored.a2a?.fromTabId) return { kind: "a2a", skill: stored.a2a.skill, text: incoming.trim() };
  return parsePromptPrefix(incoming);
}
