import { describe, expect, test } from "bun:test";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { make } from "@opencode/ai/promise";
import { model } from "../src/provider.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = new EventStreamCodec((bytes) => decoder.decode(bytes), (text) => encoder.encode(text));
function encode(type: string, data: Record<string, unknown>) {
  return codec.encode({ headers: {
    ":message-type": { type: "string", value: "event" },
    ":event-type": { type: "string", value: type },
  }, body: encoder.encode(JSON.stringify(data)) });
}
const profileArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test";

describe("native runtime over HTTP", () => {
  test("sends Kiro body/auth and completes a tool-result round trip", async () => {
    const requests: Record<string, any>[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/generateAssistantResponse");
      expect(request.headers.get("authorization")).toBe("Bearer test-access");
      expect(request.headers.get("accept")).toBe("application/vnd.amazon.eventstream");
      const body = await request.json() as Record<string, any>;
      requests.push(body);
      const bytes = requests.length === 1
        ? encode("toolUseEvent", { name: "read", toolUseId: "call-1", input: { path: "fixture.txt" }, stop: true })
        : encode("assistantResponseEvent", { content: "The file says GREEN." });
      return new Response(bytes, { headers: { "content-type": "application/vnd.amazon.eventstream" } });
    } });
    const client = make();
    const selected = model("auto", { apiKey: "test-access", profileArn, region: "us-east-1", baseURL: server.url.toString() });
    const tools = [{ name: "read", description: "Read a fixture", inputSchema: {
      type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"],
    } }];
    try {
      const first = await client.llm.generate({ model: selected, prompt: "Read fixture.txt", tools });
      expect(first.events.find((x) => x.type === "tool-call")).toMatchObject({ id: "call-1", name: "read", input: { path: "fixture.txt" } });
      const second = await client.llm.generate({ model: selected, tools, messages: [
        { role: "user", content: [{ type: "text", text: "Read fixture.txt" }] },
        { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read", input: { path: "fixture.txt" } }] },
        { role: "tool", content: [{ type: "tool-result", id: "call-1", name: "read", result: { type: "text", value: "GREEN" } }] },
      ] });
      expect(second.text).toBe("The file says GREEN.");
      expect(requests[1].profileArn).toBe(profileArn);
      expect(requests[1].conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
        { toolUseId: "call-1", status: "success", content: [{ text: "GREEN" }] },
      ]);
      expect(requests[1].conversationState.history.at(-1).assistantResponseMessage.toolUses).toEqual([
        { toolUseId: "call-1", name: "read", input: { path: "fixture.txt" } },
      ]);
    } finally { await client.dispose(); server.stop(true); }
  });

  test("cancellation closes a stalled upstream stream", async () => {
    let cancelled!: () => void;
    const closed = new Promise<void>((resolve) => { cancelled = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encode("assistantResponseEvent", { content: "start" })); },
        cancel() { cancelled(); },
      }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
    } });
    const client = make();
    const controller = new AbortController();
    try {
      const result = (async () => {
        for await (const event of client.llm.stream({
          model: model("auto", { apiKey: "test-access", profileArn, baseURL: server.url.toString() }), prompt: "Wait",
        }, { signal: controller.signal })) {
          if (event.type === "text-delta") started();
        }
      })();
      await ready;
      controller.abort(new Error("smoke cancellation"));
      await expect(result).rejects.toThrow();
      await closed;
    } finally { controller.abort(); await client.dispose(); server.stop(true); }
  });
});
