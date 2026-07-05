import { describe, it, expect } from "vitest";
import { parseLoopbackReply } from "../llmGenerateExecutor";

describe("parseLoopbackReply — loopback two-output split", () => {
  it("splits conversation prose from the <image_prompt> block", () => {
    const raw = [
      "The fabric in Image 1 reads too smooth. I'll add woven micro-texture.",
      "",
      "<image_prompt>",
      "A close-up of a linen cushion, tight woven texture, soft window light.",
      "</image_prompt>",
    ].join("\n");
    const { conversation, prompt } = parseLoopbackReply(raw);
    expect(prompt).toBe("A close-up of a linen cushion, tight woven texture, soft window light.");
    expect(conversation).toContain("too smooth");
    expect(conversation).not.toContain("<image_prompt>");
    expect(conversation).not.toContain("woven texture, soft window light"); // prompt not duplicated in convo
  });

  it("joins prose from before AND after the block", () => {
    const raw = 'Before. <image_prompt>P</image_prompt> After.';
    const { conversation, prompt } = parseLoopbackReply(raw);
    expect(prompt).toBe("P");
    expect(conversation).toBe("Before.  After.");
  });

  it("is case-insensitive on the tag", () => {
    const { prompt } = parseLoopbackReply("hi <IMAGE_PROMPT>clean</IMAGE_PROMPT>");
    expect(prompt).toBe("clean");
  });

  it("uses a placeholder when the reply is only the block", () => {
    const { conversation, prompt } = parseLoopbackReply("<image_prompt>just the prompt</image_prompt>");
    expect(prompt).toBe("just the prompt");
    expect(conversation).toBe("(image prompt updated)");
  });

  it("falls back to the full reply as the prompt when no block is present", () => {
    const raw = "a plain prompt with no tags";
    const { conversation, prompt } = parseLoopbackReply(raw);
    expect(prompt).toBe(raw);
    expect(conversation).toBe(raw);
  });
});
