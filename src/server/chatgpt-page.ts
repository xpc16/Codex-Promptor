/**
 * Everything that knows what the ChatGPT web page looks like.
 *
 * Selectors live here and nowhere else, so a redesign upstream is one file to
 * repair rather than a hunt. They are semantic attributes rather than class
 * names: `data-message-author-role`, `data-message-id` and `data-testid`
 * survive restyling, generated class names do not.
 *
 * The decisions themselves are pure functions over plain data, so they can be
 * tested against saved samples without a browser.
 */

export const SELECTORS = {
  composer: "#prompt-textarea",
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  message: "[data-message-author-role]",
  fileInput: 'input[type="file"]',
  /** Present only when signed out; its absence is not proof of being signed in. */
  loginButton: '[data-testid="login-button"]',
} as const;

export const CHATGPT_ORIGIN = "https://chatgpt.com";

export type PageMessage = { id: string; role: string; text: string };

/** One sample of the page while a turn is in flight. */
export type TurnSample = {
  at: number;
  /** The stop button is showing, which is the page saying it is still generating. */
  streaming: boolean;
  assistantId: string | null;
  assistantText: string;
};

/**
 * A turn is over when the page has stopped saying it is generating *and* the
 * answer has stopped changing.
 *
 * Either signal alone is wrong. The stop button flickers between chunks, so it
 * would report finished mid-stream; the text goes quiet while the model is
 * thinking or running a tool, so that would report finished before it began.
 */
export function turnSettled(samples: readonly TurnSample[], quietMs: number): boolean {
  const latest = samples[samples.length - 1];
  if (!latest || latest.streaming || !latest.assistantId) return false;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample.streaming || sample.assistantId !== latest.assistantId || sample.assistantText !== latest.assistantText) {
      return false;
    }
    if (latest.at - sample.at >= quietMs) return true;
  }
  return false;
}

/** The conversation id, from a URL the page is on or a resume id someone typed. */
export function conversationIdFrom(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fromUrl = /\/c\/([0-9a-zA-Z-]{8,})/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  return /^[0-9a-zA-Z-]{8,}$/.test(trimmed) ? trimmed : null;
}

export function conversationUrl(conversationId: string): string {
  return `${CHATGPT_ORIGIN}/c/${conversationId}`;
}

export type PageTurn = { turnId: string; userText: string; assistantText: string };

/**
 * Messages paired into turns.
 *
 * The assistant message's own id is the turn id: it is unique, it is stable
 * across reloads, and it is what makes `(threadId, turnId)` reconciliation
 * idempotent without inventing an id of our own. Consecutive user messages
 * before one answer are joined, which is what happens when someone sends twice
 * before the model replies.
 */
export function turnsFromMessages(messages: readonly PageMessage[]): PageTurn[] {
  const turns: PageTurn[] = [];
  let pending: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (message.text.trim()) pending.push(message.text.trim());
      continue;
    }
    if (message.role !== "assistant") continue;
    if (!message.text.trim()) continue;
    turns.push({ turnId: message.id, userText: pending.join("\n\n"), assistantText: message.text.trim() });
    pending = [];
  }
  return turns;
}

/** The shape `recordTurn` reads. Duck-typed there, so no new schema is needed. */
export function historyTurn(turn: PageTurn, startedAt: string | null, completedAt: string | null) {
  return {
    turn: { id: turn.turnId, status: "completed", startedAt, completedAt },
    items: [
      { type: "userMessage", text: turn.userText },
      { type: "agentMessage", phase: "finalAnswer", text: turn.assistantText },
    ],
  };
}

/** Read inside the page. Kept as a string so the one DOM contract stays in this file. */
export const READ_MESSAGES = `() => Array.from(document.querySelectorAll('[data-message-author-role]')).map((node) => ({
  id: node.getAttribute('data-message-id') || '',
  role: node.getAttribute('data-message-author-role') || '',
  text: (node.innerText || '').trim(),
}))`;
