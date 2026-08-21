import { describe, it, expect } from "vitest";
import { migrateLlmNodes } from "../llmNodeMigration";
import type { WorkflowNode, WorkflowEdge } from "@/types";

const llm = (data: Record<string, unknown>): WorkflowNode =>
  ({ id: "llm-1", type: "llmGenerate", position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const dataOf = (n: WorkflowNode) => n.data as Record<string, unknown>;

/**
 * These guard files already on disk: 23 llmGenerate nodes across 11 saved
 * workflows go through this on every open. A wrong mapping silently changes
 * whether a node sends its transcript.
 */
describe("migrateLlmNodes", () => {
  it("maps one-shot to rememberTurns false", () => {
    const { nodes } = migrateLlmNodes([llm({ conversationMode: false })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(false);
  });

  it("maps an absent conversationMode to rememberTurns false", () => {
    const { nodes } = migrateLlmNodes([llm({})], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(false);
  });

  it("maps conversation mode to rememberTurns true", () => {
    const { nodes } = migrateLlmNodes([llm({ conversationMode: true })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(true);
  });

  it("maps loopback to rememberTurns true and keeps the transcript", () => {
    const conversation = [{ role: "user", content: "hi" }];
    const { nodes } = migrateLlmNodes([llm({ loopbackMode: true, conversation })], []);
    expect(dataOf(nodes[0]).rememberTurns).toBe(true);
    expect(dataOf(nodes[0]).conversation).toEqual(conversation);
  });

  it("drops the loopback-only fields", () => {
    const { nodes } = migrateLlmNodes(
      [llm({ loopbackMode: true, outputPrompt: "x", lastLoopbackInput: "y" })], []);
    const d = dataOf(nodes[0]);
    expect(d.loopbackMode).toBeUndefined();
    expect(d.conversationMode).toBeUndefined();
    expect(d.outputPrompt).toBeUndefined();
    expect(d.lastLoopbackInput).toBeUndefined();
  });

  it("keeps composeInput, which every node now uses", () => {
    const { nodes } = migrateLlmNodes([llm({ loopbackMode: true, composeInput: "draft" })], []);
    expect(dataOf(nodes[0]).composeInput).toBe("draft");
  });

  it("is idempotent", () => {
    const once = migrateLlmNodes([llm({ conversationMode: true })], []);
    const twice = migrateLlmNodes(once.nodes, once.edges);
    expect(twice.nodes[0].data).toEqual(once.nodes[0].data);
  });

  it("drops edges into the removed feedback input", () => {
    const edges = [{ id: "e1", source: "a", target: "llm-1", targetHandle: "image-feedback" }] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ loopbackMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("drops edges out of the removed prompt output", () => {
    const edges = [{ id: "e1", source: "llm-1", sourceHandle: "prompt", target: "b" }] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ loopbackMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("drops edges into the removed text input, including dyn-pin slots", () => {
    const edges = [
      { id: "e1", source: "a", target: "llm-1", targetHandle: "text" },
      { id: "e2", source: "b", target: "llm-1", targetHandle: "text-0" },
    ] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ conversationMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("keeps image and video inputs, which the node still renders", () => {
    const edges = [
      { id: "e1", source: "a", target: "llm-1", targetHandle: "image" },
      { id: "e2", source: "b", target: "llm-1", targetHandle: "video" },
    ] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ conversationMode: true })], edges);
    expect(out.edges).toHaveLength(2);
  });

  it("drops edges out of the removed text output", () => {
    // Real wiring is lost here — 9 edges across 4 saved projects used it. The
    // handle no longer exists, so keeping them would leave invisible edges that
    // still resolve into request bodies. Re-wire with "Send to prompt node".
    const edges = [{ id: "e1", source: "llm-1", sourceHandle: "text", target: "b" }] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([llm({ conversationMode: true })], edges);
    expect(out.edges).toEqual([]);
  });

  it("leaves non-LLM nodes and their edges alone", () => {
    const other = { id: "p-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "x" } } as unknown as WorkflowNode;
    const edges = [{ id: "e1", source: "p-1", sourceHandle: "text", target: "b" }] as unknown as WorkflowEdge[];
    const out = migrateLlmNodes([other], edges);
    expect(out.nodes[0]).toBe(other);
    expect(out.edges).toHaveLength(1);
  });

  it("returns the same array reference when nothing changes", () => {
    const nodes = [llm({ rememberTurns: true })];
    const out = migrateLlmNodes(nodes, []);
    expect(out.nodes).toBe(nodes);
  });
});
