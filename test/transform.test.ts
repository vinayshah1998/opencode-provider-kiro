import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { LLM } from "@opencode/ai";
import { Media } from "@opencode/ai/media";
import * as OpenAI from "@opencode/ai/providers/openai";
import {
  CompactionPart,
  LanguageModel,
  Message,
  ToolCallPart,
  ToolResultPart,
  type LLMRequest,
} from "@opencode/ai";
import { buildConversation, toKiroToolUseId, type KiroConversation, type KiroHistoryEntry } from "../src/transform.js";

const readTool = {
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
};
const bashTool = {
  name: "bash",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
function request(input: Omit<LLM.RequestInput<LanguageModel>, "model">, modelId = "auto"): LLMRequest {
  return LLM.request({ model: LanguageModel.make({ id: modelId, provider: "kiro", route: OpenAI.routes[0]! }), ...input });
}
async function body(input: Omit<LLM.RequestInput<LanguageModel>, "model">, modelId = "auto"): Promise<KiroConversation> {
  return await buildConversation(request(input, modelId)) as unknown as KiroConversation;
}
function entries(value: KiroConversation): KiroHistoryEntry[] {
  return [...(value.conversationState.history ?? []), value.conversationState.currentMessage];
}
function user(entry: KiroHistoryEntry) {
  if (!("userInputMessage" in entry)) throw new Error("expected user entry");
  return entry.userInputMessage;
}
function assistant(entry: KiroHistoryEntry) {
  if (!("assistantResponseMessage" in entry)) throw new Error("expected assistant entry");
  return entry.assistantResponseMessage;
}
function call(id: string, name = "read", input: unknown = { path: "example.ts" }) {
  return ToolCallPart.make({ id, name, input });
}
function result(id: string, value: unknown, name = "read", resultType: "text" | "json" | "error" = "text") {
  return ToolResultPart.make({ id, name, result: value, resultType });
}
const claudeSchema = {
  type: "object",
  properties: {
    output_config: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "max"] } }, required: ["effort"], additionalProperties: false },
    thinking: { type: "object", properties: { type: { type: "string", enum: ["adaptive"] }, display: { type: "string", enum: ["summarized"] } }, required: ["type"], additionalProperties: false },
  },
  additionalProperties: false,
};
const gptSchema = {
  type: "object",
  properties: {
    reasoning: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] } }, required: ["effort"], additionalProperties: false },
  },
  additionalProperties: false,
};

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
});

describe("Kiro native conversation transformation", () => {
  it("sends current user and exact tool schemas without credentials in the body", async () => {
    const value = await body({ system: "Be concise.", prompt: "Hello", tools: [readTool], providerOptions: { apiKey: "not-a-real-token", profileArn: "ignored", region: "us-east-1", futureHostOption: true, conversationId: "conversation-1" } });
    expect(value).toEqual({ conversationState: {
      conversationId: "conversation-1", chatTriggerType: "MANUAL", agentTaskType: "vibe",
      currentMessage: { userInputMessage: {
        content: "Be concise.\n\nHello", modelId: "auto", origin: "KIRO_CLI",
        userInputMessageContext: { tools: [{ toolSpecification: { name: readTool.name, description: readTool.description, inputSchema: { json: readTool.inputSchema } } }] },
      } },
    } });
    expect(JSON.stringify(value)).not.toContain("not-a-real-token");
  });

  it("preserves a complete two-step tool loop and all actual outputs", async () => {
    const messages = [
      Message.user("Read the file and check it."),
      Message.assistant([Message.text("I'll inspect it."), call("read-1")]),
      Message.tool(result("read-1", "export const count = 1;\n")),
      Message.assistant([call("run-1", "bash", { command: "bun test" })]),
      Message.tool(result("run-1", { exitCode: 0, stdout: "1 test passed\n" }, "bash", "json")),
    ];
    const value = await body({ messages, tools: [readTool, bashTool] });
    const conversation = entries(value);
    expect(conversation).toHaveLength(5);
    expect(assistant(conversation[1]!).content).toBe("I'll inspect it.");
    expect(user(conversation[2]!).content).toBe("");
    expect(user(conversation[2]!).userInputMessageContext?.toolResults).toEqual([{ toolUseId: "read-1", status: "success", content: [{ text: "export const count = 1;\n" }] }]);
    expect(assistant(conversation[3]!).toolUses).toEqual([{ name: "bash", toolUseId: "run-1", input: { command: "bun test" } }]);
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("");
    expect(value.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([{ toolUseId: "run-1", status: "success", content: [{ text: '{"exitCode":0,"stdout":"1 test passed\\n"}' }] }]);
    expect(messages[2]!.content).toEqual([result("read-1", "export const count = 1;\n")]);
  });

  it("pairs concurrent tool results in declared-call order and retains error output", async () => {
    const value = await body({ tools: [readTool, bashTool], messages: [
      Message.user("Check both."), Message.assistant([call("first"), call("second", "bash", { command: "false" })]),
      Message.tool(result("second", { message: "Command exited 1", exitCode: 1 }, "bash", "error")),
      Message.tool(result("first", "file contents")),
    ] });
    expect(assistant(value.conversationState.history![1]!).toolUses?.map((item) => item.toolUseId)).toEqual(["first", "second"]);
    expect(value.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: "first", status: "success", content: [{ text: "file contents" }] },
      { toolUseId: "second", status: "error", content: [{ text: '{"message":"Command exited 1","exitCode":1}' }] },
    ]);
  });

  it("never substitutes text or truncates real empty/large tool outputs", async () => {
    const large = "x".repeat(260000);
    const value = await body({ messages: [Message.user("Read."), Message.assistant([call("empty"), call("large")]), Message.tool(result("empty", "")), Message.tool(result("large", large))], tools: [readTool] });
    const results = value.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults;
    expect(results?.[0]?.content).toEqual([{ text: "" }]);
    expect(results?.[1]?.content).toEqual([{ text: large }]);
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("");
  });

  it("relocates displaced outputs without dropping user interjections", async () => {
    const value = await body({ messages: [
      Message.user("Begin"), Message.assistant([call("a")]), Message.user("Also check tests."),
      Message.assistant([call("b", "bash", { command: "bun test" })]),
      Message.tool(result("a", "actual file output")), Message.tool(result("b", "actual test output", "bash")),
    ], tools: [readTool, bashTool] });
    const conversation = entries(value);
    expect(user(conversation[2]!).content).toBe("Also check tests.");
    expect(user(conversation[2]!).userInputMessageContext?.toolResults?.[0]?.content).toEqual([{ text: "actual file output" }]);
    expect(user(conversation[4]!).userInputMessageContext?.toolResults?.[0]?.content).toEqual([{ text: "actual test output" }]);
  });

  it("replays real historic tool calls when their definitions are retired", async () => {
    const value = await body({ messages: [Message.user("Inspect."), Message.assistant([call("old", "old_read")]), Message.tool(result("old", "actual historic output", "old_read")), Message.assistant("Done."), Message.user("Explain.")], tools: [readTool] });
    expect(assistant(value.conversationState.history![1]!).toolUses?.[0]?.name).toBe("old_read");
    expect(user(value.conversationState.history![2]!).userInputMessageContext?.toolResults?.[0]?.content).toEqual([{ text: "actual historic output" }]);
    expect(value.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.map((item) => item.toolSpecification.name)).toEqual(["read", "old_read"]);
  });

  it("maps long/invalid IDs identically for calls and results", async () => {
    const id = `call_${"a".repeat(70)}|fc_${"b".repeat(70)}`;
    const mapped = toKiroToolUseId(id);
    expect(mapped).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/);
    expect(mapped).toBe(toKiroToolUseId(id));
    expect(toKiroToolUseId("native.id:1-2")).toBe("native.id:1-2");
    expect(toKiroToolUseId("a|b")).not.toBe(toKiroToolUseId("a/b"));
    const value = await body({ messages: [Message.user("Read."), Message.assistant([call(id)]), Message.tool(result(id, "actual"))], tools: [readTool] });
    expect(assistant(value.conversationState.history![1]!).toolUses?.[0]?.toolUseId).toBe(mapped);
    expect(value.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe(mapped);
  });

  it("fails unmatched/duplicate tools instead of inventing executions or results", async () => {
    await expect(body({ messages: [Message.user("Read."), Message.assistant([call("missing")])] })).rejects.toThrow("missing results are never synthesized");
    await expect(body({ messages: [Message.tool(result("orphan", "real"))] })).rejects.toThrow("no preceding tool call");
    await expect(body({ messages: [Message.user("Read."), Message.assistant([call("a")]), Message.tool(result("a", "one")), Message.tool(result("a", "two"))] })).rejects.toThrow("duplicate tool result");
    await expect(body({ messages: [Message.user("Read."), Message.assistant([call("a"), call("a")]), Message.tool(result("a", "one"))] })).rejects.toThrow("duplicate tool call");
    await expect(body({ messages: [Message.user("Read."), Message.assistant([call("a")]), Message.tool(result("a", "real", "different"))] })).rejects.toThrow("does not match its tool name");
  });

  it("accepts JSON-string tool input but rejects non-object inputs", async () => {
    const value = await body({ messages: [Message.user("Read."), Message.assistant([call("a", "read", '{"path":"real.ts"}')]), Message.tool(result("a", "real"))] });
    expect(assistant(value.conversationState.history![1]!).toolUses?.[0]?.input).toEqual({ path: "real.ts" });
    await expect(body({ messages: [Message.user("Read."), Message.assistant([call("a", "read", "{not json")]), Message.tool(result("a", "real"))] })).rejects.toThrow("JSON object");
  });

  it("merges adjacent roles and places chronological system updates in user turns", async () => {
    const value = await body({ system: [ { type: "text", text: "Initial system." }, { type: "text", text: "Second system." } ], messages: [
      Message.user("First."), Message.user("More."), Message.assistant("A."), Message.assistant("B."),
      Message.system("Updated instruction."), Message.user("Next."),
    ] });
    const conversation = entries(value);
    expect(conversation).toHaveLength(3);
    expect(user(conversation[0]!).content).toBe("Initial system.\n\nSecond system.\n\nFirst.\n\nMore.");
    expect(assistant(conversation[1]!).content).toBe("A.\n\nB.");
    expect(user(conversation[2]!).content).toBe("Updated instruction.\n\nNext.");
  });

  it("does not leak historical private reasoning or signatures into assistant speech", async () => {
    const value = await body({ messages: [Message.user("Question."), Message.assistant([
      { type: "reasoning", text: "private reasoning", encrypted: "opaque", providerMetadata: { kiro: { signature: "signature" } } },
      Message.text("Answer."),
    ]), Message.user("Next.")] });
    expect(assistant(value.conversationState.history![1]!)).toEqual({ content: "Answer." });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("opaque");
  });

  it("retains a reasoning-only assistant turn without inventing assistant speech", async () => {
    const value = await body({ messages: [Message.user("Question."), Message.assistant([{ type: "reasoning", text: "private" }]), Message.user("Next.")] });
    expect(assistant(value.conversationState.history![1]!)).toEqual({ content: "" });
  });

  it("replays plaintext compaction and rejects foreign encrypted state", async () => {
    const value = await body({ messages: [Message.user([CompactionPart.make({ provider: "openai", text: "Prior conversation summary." })]), Message.assistant("Understood."), Message.user("Continue.")] });
    expect(user(value.conversationState.history![0]!).content).toBe("Prior conversation summary.");
    await expect(body({ messages: [Message.user([CompactionPart.make({ provider: "openai", encrypted: "foreign" })])] })).rejects.toThrow("encrypted compaction");
  });

  it("lowers assistant-owned plaintext compaction to a user context summary", async () => {
    const value = await body({ messages: [Message.assistant([CompactionPart.make({ provider: "kiro", text: "Prior conversation summary." })]), Message.user("Continue.")] });
    expect(value.conversationState.history).toBeUndefined();
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("Prior conversation summary.\n\nContinue.");
  });

  it("keeps history when compaction produced no summary", async () => {
    const value = await body({ messages: [Message.user("Earlier."), Message.assistant([CompactionPart.make({ provider: "kiro", text: null }), Message.text("Actual answer.")]), Message.user("Next.")] });
    expect(user(value.conversationState.history![0]!).content).toBe("Earlier.");
    expect(assistant(value.conversationState.history![1]!).content).toBe("Actual answer.");
  });

  it("encodes native bytes/base64 images in both historical and current turns", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const png = Buffer.from(bytes).toString("base64");
    const value = await body({ messages: [Message.user([Message.text("Before."), Message.media(Media.bytes(bytes, "image/png"))]), Message.assistant("Seen."), Message.user([Message.text("After."), Message.media(Media.base64("/9j/", "image/jpeg"))])] });
    expect(user(value.conversationState.history![0]!).images).toEqual([{ format: "png", source: { bytes: png } }]);
    expect(value.conversationState.currentMessage.userInputMessage.images).toEqual([{ format: "jpeg", source: { bytes: "/9j/" } }]);
  });

  it("materializes URL images through native media helpers and infers missing MIME", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes, { headers: { "content-type": "image/png" } }) });
    servers.push(server);
    const asset = Media.url(`${server.url}picture.png`);
    const value = await body({ prompt: [Message.text("Identify."), Message.media(asset)] });
    expect(value.conversationState.currentMessage.userInputMessage.images).toEqual([{ format: "png", source: { bytes: Buffer.from(bytes).toString("base64") } }]);
  });

  it("keeps text and image tool output without replacing the actual text", async () => {
    const png = "iVBORw0KGgo=";
    const value = await body({ messages: [Message.user("Capture."), Message.assistant([call("capture", "screenshot", {})]), Message.tool(ToolResultPart.make({ id: "capture", name: "screenshot", result: { type: "content", value: [{ type: "text", text: "Captured real viewport." }, { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "viewport.png" }] } }))] });
    const current = value.conversationState.currentMessage.userInputMessage;
    expect(current.images).toEqual([{ format: "png", source: { bytes: png } }]);
    expect(current.userInputMessageContext?.toolResults?.[0]?.content).toEqual([{ text: "Captured real viewport." }]);
    expect(current.content).toBe("");
  });

  it("fails unsupported media and references explicitly", async () => {
    await expect(body({ prompt: [Message.media(Media.bytes(new Uint8Array([1, 2]), "audio/mp3"))] })).rejects.toThrow("unsupported media type");
    await expect(body({ prompt: [Message.media(Media.ref("openai", "file-ref", "image/png"))] })).rejects.toThrow("provider media references");
  });

  it("uses a neutral prompt only for image-only/empty current messages", async () => {
    const value = await body({ prompt: [Message.media(Media.base64("iVBORw0KGgo=", "image/png"))] });
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("Please proceed with the task.");
    expect(value.conversationState.currentMessage.userInputMessage.images).toHaveLength(1);
    const empty = await body({ prompt: "" });
    expect(empty.conversationState.currentMessage.userInputMessage.content).toBe("Please proceed with the task.");
  });

  it("supports auto/none but errors on unsupported forced/parallel tool control", async () => {
    const value = await body({ prompt: "Explain.", tools: [readTool], toolChoice: "none" });
    expect(value.conversationState.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined();
    await expect(body({ prompt: "Read.", tools: [readTool], toolChoice: "required" })).rejects.toThrow("forced tool selection");
    await expect(body({ prompt: "Read.", tools: [readTool], toolChoice: "read" })).rejects.toThrow("forced tool selection");
    await expect(body({ prompt: "Read.", tools: [readTool], toolChoice: { type: "auto", disableParallelToolUse: true } })).rejects.toThrow("disabling parallel");
    await expect(body({ toolChoice: "none", messages: [Message.user("Read."), Message.assistant([call("a")]), Message.tool(result("a", "actual"))] })).rejects.toThrow("cannot be enforced");
  });
});

describe("Kiro native reasoning and generation options", () => {
  it("uses catalog effort enum and Claude adaptive thinking fields", async () => {
    const value = await body({ system: "System.", prompt: "Think.", providerOptions: { reasoningEffort: "xhigh", additionalModelRequestFieldsSchema: claudeSchema } }, "future-claude");
    expect(value.additionalModelRequestFields).toEqual({ output_config: { effort: "max" }, thinking: { type: "adaptive", display: "summarized" } });
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("<thinking_mode>enabled</thinking_mode><max_thinking_length>50000</max_thinking_length>\n\nSystem.\n\nThink.");
  });

  it("uses GPT reasoning without Claude thinking markers and clamps max to xhigh", async () => {
    const value = await body({ prompt: "Think.", providerOptions: { reasoningEffort: "max", additionalModelRequestFieldsSchema: gptSchema } }, "future-gpt");
    expect(value.additionalModelRequestFields).toEqual({ reasoning: { effort: "xhigh" } });
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("Think.");
  });

  it("uses known-model fallback only when catalog metadata is absent", async () => {
    const value = await body({ prompt: "Think.", providerOptions: { reasoningEffort: "minimal" } }, "claude-opus-4.8");
    expect(value.additionalModelRequestFields).toEqual({ output_config: { effort: "low" }, thinking: { type: "adaptive", display: "summarized" } });
    await expect(body({ prompt: "Think.", providerOptions: { reasoningEffort: "high", additionalModelRequestFieldsSchema: {} } }, "claude-opus-4.8")).rejects.toThrow("does not advertise");
    await expect(body({ prompt: "Think.", providerOptions: { reasoningEffort: "high" } }, "unrecognized-model")).rejects.toThrow("does not advertise");
  });

  it("supports explicit model effort settings and preserves absent/disabled effort", async () => {
    const configured = await body({ prompt: "Think.", providerOptions: { reasoningEffort: "high", kiroEffort: { field: "reasoning", values: ["low", "high"], summarizedThinking: false } } }, "custom-model");
    expect(configured.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
    for (const reasoningEffort of [undefined, "none", "off"]) {
      const value = await body({ prompt: "Plain.", providerOptions: { reasoningEffort } }, "claude-opus-4.8");
      expect(value.additionalModelRequestFields).toBeUndefined();
      expect(value.conversationState.currentMessage.userInputMessage.content).toBe("Plain.");
    }
  });

  it("consumes native effort marker history without inventing conversation text", async () => {
    const value = await body({ messages: [Message.user("Question."), Message.assistant("Answer."), Message.effort({ effort: "high", previous: "low" }), Message.user("Next.")], providerOptions: { additionalModelRequestFieldsSchema: gptSchema } }, "custom-model");
    expect(value.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
    expect(value.conversationState.currentMessage.userInputMessage.content).toBe("Next.");
  });

  it("validates explicit native request fields and maps schema-advertised generation", async () => {
    const schema = { type: "object", properties: { temperature: { type: "number", minimum: 0, maximum: 1 }, max_tokens: { type: "integer", minimum: 1 }, top_p: { type: "number" }, stop_sequences: { type: "array", items: { type: "string" } } }, additionalProperties: false };
    const value = await body({ prompt: "Hi.", generation: { temperature: 0.2, maxTokens: 200, topP: 0.9, stop: ["END"] }, providerOptions: { additionalModelRequestFieldsSchema: schema } });
    expect(value.additionalModelRequestFields).toEqual({ temperature: 0.2, max_tokens: 200, top_p: 0.9, stop_sequences: ["END"] });
    await expect(body({ prompt: "Hi.", providerOptions: { additionalModelRequestFieldsSchema: schema, additionalModelRequestFields: { temperature: 2 } } })).rejects.toThrow("catalog schema");
    await expect(body({ prompt: "Hi.", generation: { temperature: 0.2 }, providerOptions: { additionalModelRequestFieldsSchema: schema, additionalModelRequestFields: { temperature: 0.3 } } })).rejects.toThrow("conflicting generation");
  });

  it("warns rather than silently discarding routine host defaults", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const value = await body({ prompt: "Hi.", generation: { maxTokens: 1024, temperature: 0.5, topP: 0.9 } });
      expect(value.additionalModelRequestFields).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0]?.[0]).toContain("generation.maxTokens");
      expect(warn.mock.calls[0]?.[0]).not.toContain("1024");
    } finally { warn.mockRestore(); }
  });

  it("rejects unsupported semantic controls rather than silently losing them", async () => {
    await expect(body({ prompt: "Hi.", generation: { seed: 1 } })).rejects.toThrow("unsupported generation option seed");
    await expect(body({ prompt: "Hi.", generation: { stop: ["END"] } })).rejects.toThrow("unsupported generation option stop");
    await expect(body({ prompt: "Hi.", providerOptions: { reasoningEffort: "unsupported", additionalModelRequestFieldsSchema: gptSchema } })).rejects.toThrow("unsupported reasoning effort");
    await expect(body({ prompt: "Hi.", providerOptions: { additionalModelRequestFields: { unavailable: true } } })).rejects.toThrow("requires the model's catalog schema");
    await expect(body({ prompt: "Hi.", providerOptions: { reasoningEffort: "high", reasoning: "low" } }, "claude-opus-4.8")).rejects.toThrow("conflict");
  });
});
