import { describe, expect, test } from "bun:test";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { FrameDecoder, finish, initial, providerError, step, type WireEvent } from "../src/stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = new EventStreamCodec((bytes) => decoder.decode(bytes), (text) => encoder.encode(text));
function frame(type: string, data: Record<string, unknown>, kind = "event") {
  return codec.encode({
    headers: {
      ":message-type": { type: "string", value: kind },
      [kind === "exception" ? ":exception-type" : ":event-type"]: { type: "string", value: type },
    },
    body: encoder.encode(JSON.stringify(data)),
  });
}
function event(type: string, data: Record<string, unknown>): WireEvent { return { kind: "event", type, data }; }

describe("AWS EventStream framing", () => {
  test("decodes split binary frames and multi-byte text without loss", () => {
    const first = frame("assistantResponseEvent", { content: "Hello 世界" });
    const second = frame("toolUseEvent", { name: "read", toolUseId: "one", input: "{}", stop: true });
    const all = new Uint8Array(first.length + second.length);
    all.set(first); all.set(second, first.length);
    for (const size of [1, 3, 17, all.length]) {
      const parser = new FrameDecoder();
      const events: WireEvent[] = [];
      for (let at = 0; at < all.length; at += size) events.push(...parser.push(all.subarray(at, at + size)));
      parser.finish();
      expect(events).toEqual([
        event("assistantResponseEvent", { content: "Hello 世界" }),
        event("toolUseEvent", { name: "read", toolUseId: "one", input: "{}", stop: true }),
      ]);
    }
  });
  test("rejects corrupt CRC, truncated bodies and invalid frame lengths", () => {
    const bytes = frame("assistantResponseEvent", { content: "text" });
    bytes[bytes.length - 1] ^= 1;
    expect(() => new FrameDecoder().push(bytes)).toThrow("checksum");
    const parser = new FrameDecoder();
    parser.push(bytes.subarray(0, 12));
    expect(() => parser.finish()).toThrow("inside a frame");
    expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 0]))).toThrow("length");
    expect(() => new FrameDecoder().push(new Uint8Array([127, 255, 255, 255]))).toThrow("length");
  });
});

describe("Kiro response lifecycle", () => {
  test("emits complete tool input once, followed by tool-calls finish", () => {
    const state = initial();
    const events = [
      ...step(state, event("toolUseEvent", { name: "read", toolUseId: "tool-1", input: '{"path":' }))[1],
      ...step(state, event("toolUseEvent", { input: '"file.txt"}' }))[1],
      ...step(state, event("toolUseEvent", { stop: true }))[1],
      ...finish(state),
    ];
    expect(events.filter((x) => x.type === "tool-call")).toEqual([
      { type: "tool-call", id: "tool-1", name: "read", input: { path: "file.txt" } },
    ]);
    expect(events.map((x) => x.type)).toEqual([
      "step-start", "tool-input-start", "tool-input-delta", "tool-input-delta", "tool-input-end", "tool-call", "step-finish", "finish",
    ]);
    expect(events.at(-1)).toMatchObject({ reason: { normalized: "tool-calls" } });
  });
  test("keeps reasoning separate, retains signatures and inclusive usage plus credits", () => {
    const state = initial();
    const events = [
      ...step(state, event("reasoningContentEvent", { text: "think", signature: "sig" }))[1],
      ...step(state, event("assistantResponseEvent", { content: "answer" }))[1],
      ...step(state, event("metadataEvent", { stopReason: "end_turn", tokenUsage: {
        uncachedInputTokens: 4, cacheReadInputTokens: 10, cacheWriteInputTokens: 2, outputTokens: 3,
      } }))[1],
      ...step(state, event("meteringEvent", { usage: 0.2, unit: "credit" }))[1],
      ...finish(state),
    ];
    expect(events.find((x) => x.type === "reasoning-end")).toMatchObject({ providerMetadata: { kiro: { signature: "sig" } } });
    expect(events.filter((x) => x.type === "text-delta")).toEqual([{ type: "text-delta", id: "text-1", text: "answer" }]);
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 16, nonCachedInputTokens: 4, outputTokens: 3, totalTokens: 19 },
      providerMetadata: { kiro: { metering: { usage: 0.2, unit: "credit" } } },
    });
  });
  test("fails malformed or unfinished tool calls rather than execute partial input", () => {
    const state = initial();
    step(state, event("toolUseEvent", { name: "write", toolUseId: "one", input: '{"path":' }));
    expect(() => finish(state)).toThrow("unfinished tool");
    expect(() => step(state, event("toolUseEvent", { stop: true }))).toThrow("malformed");
    expect(() => finish(initial())).toThrow("empty response");
  });
  test("rejects orphan fragments and repeated completed IDs", () => {
    expect(() => step(initial(), event("toolUseEvent", { input: "{}" }))).toThrow("without a tool-call");
    const state = initial();
    step(state, event("toolUseEvent", { name: "read", toolUseId: "one", input: {}, stop: true }));
    expect(() => step(state, event("toolUseEvent", { name: "read", toolUseId: "one", stop: true }))).toThrow("reused");
  });
  test("classifies quota, context overflow, rate limits and authentication separately", () => {
    expect(providerError("throttlingError", { reason: "MONTHLY_REQUEST_COUNT" }).reason._tag).toBe("QuotaExceeded");
    expect(providerError("validationError", { reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }).reason).toMatchObject({ classification: "context-overflow" });
    expect(providerError("ThrottlingException", { retryAfterMilliseconds: 400 }).reason).toMatchObject({ _tag: "RateLimit", retryAfterMs: 400 });
    expect(providerError("AccessDeniedException", {}).reason._tag).toBe("Authentication");
    expect(() => step(initial(), { kind: "exception", type: "serviceUnavailableError", data: { message: "unavailable" } })).toThrow("unavailable");
  });
});

test("legacy reasoning tags survive arbitrary chunk boundaries without leaking into text", () => {
  const wire = "<thinking>compute 17 * 19</thinking>323";
  for (const size of [1, 4, wire.length]) {
    const state = initial(true);
    const events = [];
    for (let at = 0; at < wire.length; at += size) events.push(...step(state, event("assistantResponseEvent", { content: wire.slice(at, at + size) }))[1]);
    events.push(...finish(state));
    expect(events.filter((entry) => entry.type === "reasoning-delta").map((entry) => entry.text).join("")).toBe("compute 17 * 19");
    expect(events.filter((entry) => entry.type === "text-delta").map((entry) => entry.text).join("")).toBe("323");
  }
  const ordinary = initial();
  expect(step(ordinary, event("assistantResponseEvent", { content: "literal <thinking>markup</thinking>" }))[1].find((entry) => entry.type === "text-delta")).toMatchObject({ text: "literal <thinking>markup</thinking>" });
});
