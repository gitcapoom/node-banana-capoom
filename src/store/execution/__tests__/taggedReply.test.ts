import { describe, it, expect } from "vitest";
import { parseTaggedReply } from "../taggedReply";

describe("parseTaggedReply", () => {
  it("extracts both blocks", () => {
    const r = parseTaggedReply("Sure.\n<prompt>a warehouse</prompt>\n<negative_prompt>blurry</negative_prompt>");
    expect(r.prompt).toBe("a warehouse");
    expect(r.negativePrompt).toBe("blurry");
  });

  it("extracts the positive when the negative is absent", () => {
    const r = parseTaggedReply("Sure.\n<prompt>a warehouse</prompt>");
    expect(r.prompt).toBe("a warehouse");
    expect(r.negativePrompt).toBeNull();
  });

  it("returns nulls when no block is present", () => {
    const r = parseTaggedReply("I think the set should feel industrial.");
    expect(r.prompt).toBeNull();
    expect(r.negativePrompt).toBeNull();
  });

  it("keeps the RAW reply, tags included — history stays faithful", () => {
    const raw = "Sure.\n<prompt>a warehouse</prompt>";
    expect(parseTaggedReply(raw).reply).toBe(raw);
  });

  it("handles multi-line content and stray angle brackets", () => {
    const r = parseTaggedReply("<prompt>line one,\nline two <lens> 35mm</prompt>");
    expect(r.prompt).toBe("line one,\nline two <lens> 35mm");
  });

  it("ignores an unclosed tag rather than throwing", () => {
    expect(parseTaggedReply("<prompt>never closed").prompt).toBeNull();
  });

  it("takes the LAST block when the model emits several", () => {
    // A model that restates itself has settled on the final answer.
    const r = parseTaggedReply("<prompt>first</prompt> then <prompt>second</prompt>");
    expect(r.prompt).toBe("second");
  });

  it("trims whitespace inside a block", () => {
    expect(parseTaggedReply("<prompt>\n  spaced  \n</prompt>").prompt).toBe("spaced");
  });

  it("treats an empty block as absent", () => {
    expect(parseTaggedReply("<prompt>   </prompt>").prompt).toBeNull();
  });

  it("does not mistake negative_prompt for prompt", () => {
    const r = parseTaggedReply("<negative_prompt>blurry</negative_prompt>");
    expect(r.prompt).toBeNull();
    expect(r.negativePrompt).toBe("blurry");
  });

  it("matches tags case-insensitively, as the loopback parser did", () => {
    expect(parseTaggedReply("hi <PROMPT>clean</PROMPT>").prompt).toBe("clean");
    expect(parseTaggedReply("<Negative_Prompt>blurry</Negative_Prompt>").negativePrompt).toBe("blurry");
  });

  it("never throws on any input", () => {
    for (const s of ["", "<prompt>", "</prompt>", "<<>>", " ", "<prompt><prompt>"]) {
      expect(() => parseTaggedReply(s)).not.toThrow();
    }
  });
});
