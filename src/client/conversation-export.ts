import { promptorApiHeaders } from "./api-client.js";
import { PromptorApiError } from "./i18n.js";

function exportedFilename(response: Response): string {
  const encoded = response.headers.get("x-codex-promptor-filename");
  if (!encoded) return "codex-promptor-conversation.md";
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded && !/[\\/\u0000-\u001f]/.test(decoded) ? decoded : "codex-promptor-conversation.md";
  } catch {
    return "codex-promptor-conversation.md";
  }
}

export async function downloadConversationMarkdown(tabId: string, locale: "zh-CN" | "en"): Promise<void> {
  const response = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/export.md?locale=${encodeURIComponent(locale)}`, {
    headers: promptorApiHeaders(),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PromptorApiError(
      String(payload?.error?.code ?? "CONVERSATION_EXPORT_FAILED"),
      String(payload?.error?.message ?? `HTTP ${response.status}`),
      response.status,
      Boolean(payload?.error?.retryable),
      payload?.error?.details && typeof payload.error.details === "object" ? payload.error.details : {},
    );
  }

  const href = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = exportedFilename(response);
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}
