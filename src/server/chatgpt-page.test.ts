import { describe, expect, it } from "vitest";
import { conversationIdFrom, conversationUrl, turnSettled, turnsFromMessages, type TurnSample } from "./chatgpt-page.js";
import { AttachmentError, parseAttachments, resolveAttachments } from "./attach-prefix.js";

/**
 * The judgements a browser page needs, as pure functions.
 *
 * They are separated from the page IO for one reason: the page is the part
 * that will change without warning, and these are the part that has to be
 * right when it does.
 */

const sample = (at: number, streaming: boolean, text: string, id = "a1"): TurnSample => ({
  at, streaming, assistantId: id, assistantText: text,
});

describe("deciding a web turn is over", () => {
  it("waits for the page to stop generating and the text to stop moving", () => {
    // Streaming, so not settled however long the text has been the same.
    expect(turnSettled([sample(0, true, "答"), sample(400, true, "答案")], 1_000)).toBe(false);
    // Stopped generating, but only just: the answer has not been still long enough.
    expect(turnSettled([sample(0, true, "答"), sample(400, false, "答案")], 1_000)).toBe(false);
    expect(turnSettled([sample(0, false, "答案"), sample(1_200, false, "答案")], 1_000)).toBe(true);
  });

  it("does not call a pause in the middle of streaming the end", () => {
    // The text goes quiet while a tool runs; the stop button is what says the
    // turn is still alive, and it outranks the quiet.
    const samples = [sample(0, false, "第一段"), sample(600, true, "第一段"), sample(1_400, true, "第一段")];
    expect(turnSettled(samples, 1_000)).toBe(false);
  });

  it("restarts the clock when the answer is replaced by a different message", () => {
    const samples = [sample(0, false, "旧的", "a1"), sample(1_500, false, "新的", "a2")];
    expect(turnSettled(samples, 1_000)).toBe(false);
  });

  it("is never settled before an assistant message exists", () => {
    expect(turnSettled([{ at: 0, streaming: false, assistantId: null, assistantText: "" }], 0)).toBe(false);
    expect(turnSettled([], 1_000)).toBe(false);
  });
});

describe("the conversation id", () => {
  it("comes out of a URL, a bare id, or nothing", () => {
    expect(conversationIdFrom("https://chatgpt.com/c/68b0f2a1-dead-beef")).toBe("68b0f2a1-dead-beef");
    expect(conversationIdFrom("  68b0f2a1-dead-beef  ")).toBe("68b0f2a1-dead-beef");
    expect(conversationIdFrom("https://chatgpt.com/")).toBeNull();
    expect(conversationIdFrom("")).toBeNull();
  });

  it("round-trips through the URL it builds", () => {
    expect(conversationIdFrom(conversationUrl("abc12345"))).toBe("abc12345");
  });
});

describe("pairing messages into turns", () => {
  it("uses the assistant message's own id, which is what makes reconciliation idempotent", () => {
    const turns = turnsFromMessages([
      { id: "u1", role: "user", text: "问题一" },
      { id: "a1", role: "assistant", text: "回答一" },
      { id: "u2", role: "user", text: "问题二" },
      { id: "a2", role: "assistant", text: "回答二" },
    ]);
    expect(turns).toEqual([
      { turnId: "a1", userText: "问题一", assistantText: "回答一" },
      { turnId: "a2", userText: "问题二", assistantText: "回答二" },
    ]);
  });

  it("joins two prompts sent before one answer", () => {
    const turns = turnsFromMessages([
      { id: "u1", role: "user", text: "先说一半" },
      { id: "u2", role: "user", text: "再补一句" },
      { id: "a1", role: "assistant", text: "好的" },
    ]);
    expect(turns).toEqual([{ turnId: "a1", userText: "先说一半\n\n再补一句", assistantText: "好的" }]);
  });

  it("ignores an answer that has not started, and anything that is neither", () => {
    const turns = turnsFromMessages([
      { id: "s1", role: "system", text: "忽略我" },
      { id: "u1", role: "user", text: "问题" },
      { id: "a1", role: "assistant", text: "   " },
    ]);
    expect(turns).toEqual([]);
  });
});

describe("/attach", () => {
  it("takes the leading lines and leaves the body alone", () => {
    const parsed = parseAttachments("/attach D:\\repo\\docs\\PLAN.md\n/attach C:\\a.png\n请评审这份文档。");
    expect(parsed.paths).toEqual(["D:\\repo\\docs\\PLAN.md", "C:\\a.png"]);
    expect(parsed.body).toBe("请评审这份文档。");
  });

  it("only reads them at the head, so a mention further down stays text", () => {
    const parsed = parseAttachments("说明一下 /attach 是怎么用的\n/attach D:\\a.md");
    expect(parsed.paths).toEqual([]);
    expect(parsed.body).toBe("说明一下 /attach 是怎么用的\n/attach D:\\a.md");
  });

  it("leaves an ordinary prompt untouched", () => {
    expect(parseAttachments("普通问题")).toEqual({ paths: [], body: "普通问题" });
  });

  it("resolves what a person typed against their own directory, with no limit", () => {
    expect(resolveAttachments(["docs\\PLAN.md"], { baseDir: "D:\\repo" })).toEqual(["D:\\repo\\docs\\PLAN.md"]);
    expect(resolveAttachments(["C:\\elsewhere\\secret.txt"], { baseDir: "D:\\repo" })).toEqual(["C:\\elsewhere\\secret.txt"]);
  });

  it("confines what arrived inside a collaboration message", () => {
    // The message text decides which local file leaves this machine, so it can
    // only name what its sender could already reach.
    const roots = ["D:\\repo", "D:\\app\\data\\a2a\\files\\root-1"];
    expect(resolveAttachments(["D:\\repo\\docs\\PLAN.md"], { baseDir: "D:\\repo", allowedRoots: roots }))
      .toEqual(["D:\\repo\\docs\\PLAN.md"]);
    expect(() => resolveAttachments(["C:\\Users\\me\\.ssh\\id_rsa"], { baseDir: "D:\\repo", allowedRoots: roots }))
      .toThrow(AttachmentError);
    // Including by climbing out of an allowed root.
    expect(() => resolveAttachments(["D:\\repo\\..\\other\\x.md"], { baseDir: "D:\\repo", allowedRoots: roots }))
      .toThrow(AttachmentError);
  });
});
