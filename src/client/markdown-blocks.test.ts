import { describe, expect, it } from "vitest";
import { MarkdownBlockAssembler } from "./markdown-blocks.js";

describe("MarkdownBlockAssembler", () => {
  it("commits complete paragraphs and retains an incomplete tail", () => {
    const assembler = new MarkdownBlockAssembler();
    expect(assembler.append("first\n\nsec")).toEqual({ blocks: ["first\n\n"], pending: "sec" });
    expect(assembler.append("ond\n\nthird")).toEqual({ blocks: ["second\n\n"], pending: "third" });
  });

  it("does not split fenced code on blank lines", () => {
    const assembler = new MarkdownBlockAssembler();
    const result = assembler.append("```ts\nconst a = 1\n\n");
    expect(result.blocks).toEqual([]);
    expect(result.pending).toContain("const a");
    expect(assembler.append("```\n\nafter").blocks[0]).toContain("```ts");
  });

  it("keeps a loose list together across a blank line", () => {
    const assembler = new MarkdownBlockAssembler();
    const result = assembler.append("- one\n\n- two\n\nnext");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toContain("- two");
    expect(result.pending).toBe("next");
  });

  it("flushes the final tail", () => {
    const assembler = new MarkdownBlockAssembler();
    assembler.append("unfinished");
    expect(assembler.append(" end", true)).toEqual({ blocks: ["unfinished end"], pending: "" });
  });
});
