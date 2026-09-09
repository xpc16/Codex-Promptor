/**
 * The name a tab takes when it becomes something other than a conversation.
 *
 * An encryption switch and a plain terminal are not conversations with an
 * agent, and leaving them called "新对话" makes a sidebar of them unreadable --
 * the two things that most need to be findable at a glance are the two that
 * look like everything else.
 *
 * Only a name nobody chose is replaced. Someone who typed "工作机加密" before
 * connecting meant it, and having that overwritten by the act of connecting
 * would be worse than never naming anything.
 */

export type TabNameLocale = "zh-CN" | "en";

/** Providers that get a name; the agents keep whatever the reader called them. */
const AUTO_NAMES = {
  // Not "端到端加密": this sits in a narrow sidebar, and the acronym reads the
  // same in both languages.
  e2ee: { "zh-CN": "E2EE", en: "E2EE" },
  shell: { "zh-CN": "终端", en: "Terminal" },
} as const;

export type AutoNamedProvider = keyof typeof AUTO_NAMES;

/**
 * Every name that means "nobody has named this yet".
 *
 * Both locales are always in here, whichever one is in use: a tab created
 * while the page was in English and configured after switching to Chinese is
 * still an unnamed tab.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "未命名对话",
  "新对话",
  "New conversation",
]);

export function nameIsPlaceholder(name: string): boolean {
  return PLACEHOLDERS.has(name.trim());
}

export function autoTabName(provider: string, locale: TabNameLocale): string | null {
  return provider in AUTO_NAMES ? AUTO_NAMES[provider as AutoNamedProvider][locale] : null;
}

/** The name a tab should carry after this session type was opened on it. */
export function nameForSession(current: string, provider: string, locale: TabNameLocale): string {
  const automatic = autoTabName(provider, locale);
  return automatic && nameIsPlaceholder(current) ? automatic : current;
}
