import path from "node:path";

/**
 * `/attach <path>` lines at the head of a prompt.
 *
 * Same two rules the `@@` prefix settled on: the stored text keeps what the
 * author wrote, and what is actually submitted is kept separately on the
 * attempt. One syntax, whether a person typed it or an agent sent it -- which
 * is why `send` needs no `files` parameter of its own.
 */

const ATTACH = /^\/attach[ \t]+(\S.*)$/;

export type PromptAttachments = { paths: string[]; body: string };

export class AttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Split the leading `/attach` lines off a prompt. Only leading ones count. */
export function parseAttachments(text: string): PromptAttachments {
  const lines = text.split(/\r?\n/);
  const paths: string[] = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) { if (paths.length) continue; break; }
    const match = ATTACH.exec(line);
    if (!match) break;
    paths.push(match[1].trim().replace(/^["']|["']$/g, ""));
  }
  return { paths, body: lines.slice(index).join("\n").trim() };
}

/**
 * Turn the written paths into absolute ones, and refuse anything a message
 * from another conversation may not reach.
 *
 * A person typing `/attach` in their own conversation is using their own
 * machine and gets no restriction. A path that arrived inside an A2A message
 * is different: that text decides which local file leaves this machine, so it
 * is confined to what the sender could already see -- its own working
 * directory, or the collaboration's exchange directory. This bounds mistakes,
 * not malice: an agent that can run a shell could read those files anyway.
 */
export function resolveAttachments(
  paths: readonly string[],
  options: { baseDir: string; allowedRoots?: readonly string[] },
): string[] {
  return paths.map((written) => {
    const absolute = path.resolve(options.baseDir, written);
    if (options.allowedRoots && !options.allowedRoots.some((root) => contains(root, absolute))) {
      throw new AttachmentError("ATTACH_PATH_NOT_ALLOWED", `协作消息只能附带发送方工作目录或协作交换目录里的文件：${written}`);
    }
    return absolute;
  });
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
