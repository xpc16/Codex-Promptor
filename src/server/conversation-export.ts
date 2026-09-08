import type { AgentProvider, AnswerStatus, Origin, PromptStatus, TabBundle } from "../shared/schemas.js";

export type ConversationExportLocale = "zh-CN" | "en";

const providerNames: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor CLI",
  shell: "PowerShell",
  // Never exported: this tab is the encryption switch, not a conversation.
  e2ee: "End-to-end encryption",
};

const zh = {
  title: "对话导出",
  info: "对话信息",
  queue: "执行队列",
  answers: "最终回答",
  name: "名称",
  tabId: "标签 ID",
  provider: "编程代理",
  state: "连接状态",
  workingDirectory: "工作路径",
  threadId: "Thread ID",
  sessionId: "Session ID",
  createdAt: "创建时间",
  connectedAt: "连接时间",
  exportedAt: "导出时间",
  origin: "来源",
  startedAt: "开始时间",
  completedAt: "完成时间",
  error: "错误",
  prompt: "Prompt",
  finalAnswer: "最终回答",
  captureMode: "记录方式",
  turnId: "Turn ID",
  emptyQueue: "暂无 Prompt。",
  emptyAnswers: "暂无最终回答。",
  empty: "（空）",
  states: { unconfigured: "未连接", connecting: "连接中", ready: "已打开", closed: "已关闭", error: "错误" },
  promptStatuses: { pending: "待执行", dispatching: "发送中", running: "执行中", completed: "已完成", failed: "失败", interrupted: "已中断", skipped: "已跳过" },
  answerStatuses: { running: "执行中", completed: "已完成", interrupted: "已中断", failed: "失败" },
  origins: { queue: "执行队列", manual: "手动输入", imported: "历史导入", timer: "定时器" },
} as const;

const en = {
  title: "Conversation export",
  info: "Conversation information",
  queue: "Prompt queue",
  answers: "Final answers",
  name: "Name",
  tabId: "Tab ID",
  provider: "Agent",
  state: "Connection state",
  workingDirectory: "Working directory",
  threadId: "Thread ID",
  sessionId: "Session ID",
  createdAt: "Created",
  connectedAt: "Connected",
  exportedAt: "Exported",
  origin: "Origin",
  startedAt: "Started",
  completedAt: "Completed",
  error: "Error",
  prompt: "Prompt",
  finalAnswer: "Final answer",
  captureMode: "Capture mode",
  turnId: "Turn ID",
  emptyQueue: "No prompts.",
  emptyAnswers: "No final answers.",
  empty: "(empty)",
  states: { unconfigured: "Not connected", connecting: "Connecting", ready: "Open", closed: "Closed", error: "Error" },
  promptStatuses: { pending: "Pending", dispatching: "Dispatching", running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted", skipped: "Skipped" },
  answerStatuses: { running: "Running", completed: "Completed", interrupted: "Interrupted", failed: "Failed" },
  origins: { queue: "Prompt queue", manual: "Manual", imported: "Imported history", timer: "Timer" },
};

function headingText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>])/g, "\\$1").trim() || "Untitled";
}

function inlineCode(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function textBlock(value: string, empty: string): string {
  const text = value.replace(/\r\n?/g, "\n").trimEnd();
  if (!text) return empty;
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function errorText(error: { code: string; message: string } | null): string | null {
  return error ? `${error.code}: ${error.message}` : null;
}

export function buildConversationMarkdown(bundle: TabBundle, locale: ConversationExportLocale, exportedAt = new Date()): string {
  const l = locale === "en" ? en : zh;
  const { tab } = bundle;
  const session = tab.session;
  const lines = [
    `# ${headingText(tab.name)} — ${l.title}`,
    "",
    `## ${l.info}`,
    "",
    `- ${l.name}: ${inlineCode(tab.name)}`,
    `- ${l.tabId}: ${inlineCode(tab.id)}`,
    `- ${l.provider}: ${providerNames[session.provider]}`,
    `- ${l.state}: ${l.states[session.state]}`,
    `- ${l.workingDirectory}: ${inlineCode(session.workingDirectory)}`,
    `- ${l.threadId}: ${inlineCode(session.threadId)}`,
    `- ${l.sessionId}: ${inlineCode(session.sessionId)}`,
    `- ${l.createdAt}: ${inlineCode(session.createdAt ?? tab.createdAt)}`,
    `- ${l.connectedAt}: ${inlineCode(session.connectedAt)}`,
    `- ${l.exportedAt}: ${inlineCode(exportedAt.toISOString())}`,
    "",
    `## ${l.queue}`,
    "",
  ];

  if (bundle.prompts.prompts.length === 0) lines.push(l.emptyQueue, "");
  bundle.prompts.prompts.forEach((prompt, index) => {
    lines.push(
      `### ${index + 1}. ${l.prompt} · ${l.promptStatuses[prompt.status as PromptStatus]}`,
      "",
      `- ${l.origin}: ${l.origins[prompt.origin as Origin]}`,
      `- ${l.createdAt}: ${inlineCode(prompt.createdAt)}`,
      `- ${l.startedAt}: ${inlineCode(prompt.startedAt)}`,
      `- ${l.completedAt}: ${inlineCode(prompt.completedAt)}`,
    );
    const promptError = errorText(prompt.error);
    if (promptError) lines.push(`- ${l.error}: ${inlineCode(promptError)}`);
    lines.push("", textBlock(prompt.text, l.empty), "");
  });

  lines.push(`## ${l.answers}`, "");
  if (bundle.answers.answers.length === 0) lines.push(l.emptyAnswers, "");
  bundle.answers.answers.forEach((answer, index) => {
    lines.push(
      `### ${index + 1}. ${l.answerStatuses[answer.status as AnswerStatus]}`,
      "",
      `- ${l.origin}: ${l.origins[answer.origin as Origin]}`,
      `- ${l.startedAt}: ${inlineCode(answer.startedAt)}`,
      `- ${l.completedAt}: ${inlineCode(answer.completedAt)}`,
      `- ${l.turnId}: ${inlineCode(answer.codexTurnId)}`,
      `- ${l.captureMode}: ${inlineCode(answer.captureMode)}`,
    );
    const answerError = errorText(answer.error);
    if (answerError) lines.push(`- ${l.error}: ${inlineCode(answerError)}`);
    lines.push(
      "",
      `#### ${l.prompt}`,
      "",
      textBlock(answer.prompt, l.empty),
      "",
      `#### ${l.finalAnswer}`,
      "",
      answer.finalAnswer.replace(/\r\n?/g, "\n").trimEnd() || l.empty,
      "",
      "---",
      "",
    );
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

export function conversationExportFilename(name: string, exportedAt = new Date()): string {
  const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 80) || "conversation";
  const stamp = exportedAt.toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
  return `${safeName}-${stamp}.md`;
}
