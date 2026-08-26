export type TabLoadRetryOptions = {
  delays?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
};

const defaultDelays = [120, 320, 800] as const;

export const MAX_RETAINED_TAB_VIEWS = 2;

export function retainRecentTabIds(
  current: readonly string[],
  selectedId: string | null,
  validIds: ReadonlySet<string>,
  limit = MAX_RETAINED_TAB_VIEWS,
): string[] {
  const selected = selectedId && validIds.has(selectedId) ? selectedId : null;
  const recent = current.filter((tabId, index) => validIds.has(tabId)
    && tabId !== selected
    && current.lastIndexOf(tabId) === index);
  if (selected) recent.push(selected);
  return recent.slice(-Math.max(1, limit));
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isRetryableTabLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  if (!("retryable" in error)) return true;
  return Boolean((error as { retryable?: unknown }).retryable);
}

export async function loadTabWithRetry<T>(
  load: () => Promise<T>,
  options: TabLoadRetryOptions = {},
): Promise<T> {
  const delays = options.delays ?? defaultDelays;
  const wait = options.wait ?? defaultWait;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (!isRetryableTabLoadError(error) || attempt === delays.length) throw error;
      await wait(delays[attempt]);
    }
  }

  throw lastError;
}
