import { EventStreamCodec } from "@smithy/eventstream-codec";
import { Effect, Schema, Stream } from "effect";
import { AIError, AuthenticationError, InvalidProviderOutputError, InvalidRequestError, LLMEvent, ProviderInternalError, QuotaExceededError, RateLimitError, Usage, } from "@opencode/ai";
import { Lifecycle } from "@opencode/ai/protocols/utils/lifecycle";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const codec = new EventStreamCodec((bytes) => decoder.decode(bytes), (text) => encoder.encode(text));
const MAX_FRAME = 16 * 1024 * 1024;
export function outputError(message, incomplete = false) {
    return new AIError({ reason: new InvalidProviderOutputError({
            route: "kiro", message,
            ...(incomplete ? { classification: "incomplete-stream" } : {}),
        }) });
}
export const WireEvent = Schema.Struct({
    kind: Schema.String,
    type: Schema.String,
    data: Schema.Record(Schema.String, Schema.Unknown),
});
/** Retains only the unfinished frame; growth is amortized, bounded before allocation. */
export class FrameDecoder {
    buffer = new Uint8Array(4096);
    length = 0;
    push(bytes) {
        const events = [];
        let offset = 0;
        while (offset < bytes.length) {
            const target = this.length < 4 ? 4 : this.frameLength();
            const count = Math.min(target - this.length, bytes.length - offset);
            if (target > this.buffer.length) {
                const next = new Uint8Array(Math.min(MAX_FRAME, Math.max(target, this.buffer.length * 2)));
                next.set(this.buffer.subarray(0, this.length));
                this.buffer = next;
            }
            this.buffer.set(bytes.subarray(offset, offset + count), this.length);
            this.length += count;
            offset += count;
            if (this.length < 4 || this.length !== this.frameLength())
                continue;
            const decoded = (() => {
                try {
                    return codec.decode(this.buffer.subarray(0, this.length));
                }
                catch {
                    throw outputError("Invalid Kiro EventStream checksum or frame headers");
                }
            })();
            this.length = 0;
            const header = (name) => {
                const field = decoded.headers[name];
                return field?.type === "string" ? field.value : undefined;
            };
            const kind = header(":message-type");
            const type = header(kind === "exception" ? ":exception-type" : kind === "error" ? ":error-code" : ":event-type");
            if (!kind || !type)
                throw outputError("Kiro EventStream frame is missing its type headers");
            let data;
            try {
                data = decoded.body.length ? JSON.parse(decoder.decode(decoded.body)) : {};
            }
            catch {
                throw outputError("Invalid JSON in Kiro EventStream payload");
            }
            if (!data || typeof data !== "object" || Array.isArray(data))
                throw outputError("Kiro event payload must be an object");
            events.push({ kind, type, data: { ...data, ...(header(":error-message") ? { message: header(":error-message") } : {}) } });
        }
        return events;
    }
    frameLength() {
        const size = new DataView(this.buffer.buffer).getUint32(0, false);
        if (size < 16 || size > MAX_FRAME)
            throw outputError("Kiro EventStream frame length is outside the allowed range");
        return size;
    }
    finish() {
        if (this.length)
            throw outputError("Kiro EventStream ended inside a frame", true);
    }
}
export const framing = {
    id: "kiro-event-stream",
    frame: (bytes) => bytes.pipe(Stream.map((bytes) => bytes), Stream.concat(Stream.succeed(null)), Stream.mapAccumEffect(() => new FrameDecoder(), (state, bytes) => Effect.try({
        try: () => [state, bytes === null ? (state.finish(), []) : state.push(bytes)],
        catch: (error) => error instanceof AIError ? error : outputError("Unable to decode Kiro EventStream"),
    }))),
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/** Native exception names and their modeled union aliases are both used on the wire. */
export function providerError(type, data, status) {
    const reason = typeof data.reason === "string" ? data.reason : "";
    const message = [type, reason, typeof data.message === "string" ? data.message : ""].filter(Boolean).join(": ");
    const common = { message };
    const retryAfterMs = number(data.retryAfterMilliseconds);
    if (/MONTHLY_REQUEST_COUNT|QUOTA|BUDGET|DAILY_REQUEST_COUNT|USAGE_LIMIT/.test(reason)) {
        return new AIError({ reason: new QuotaExceededError(common) });
    }
    if (status === 401 || status === 403 || /Unauthorized|AccessDenied|InvalidToken/.test(type)) {
        return new AIError({ reason: new AuthenticationError(common) });
    }
    if (/CONTEXT|TOO_LONG|TOO_LARGE|CONTENT_LENGTH|INPUT_TOO|MAX_INPUT/.test(reason) || status === 413) {
        return new AIError({ reason: new InvalidRequestError({ ...common, classification: "context-overflow" }) });
    }
    if (/throttl/i.test(type) || status === 429) {
        return new AIError({ reason: new RateLimitError({ ...common, retryAfterMs }) });
    }
    if (/validation/i.test(type) || status === 400)
        return new AIError({ reason: new InvalidRequestError(common) });
    return new AIError({ reason: new ProviderInternalError({ ...common, retryAfterMs }) });
}
export function initial(tagged = false) {
    return { lifecycle: Lifecycle.initial(), toolIDs: new Set(), hasContent: false, hasTools: false, metadata: {}, block: 0, tagged, pendingText: "" };
}
function closeChannel(state, out) {
    if (state.channel === "text")
        state.lifecycle = Lifecycle.textEnd(state.lifecycle, out, `text-${state.block}`);
    if (state.channel === "reasoning") {
        state.lifecycle = Lifecycle.reasoningEnd(state.lifecycle, out, `reasoning-${state.block}`, state.signature ? { kiro: { signature: state.signature } } : undefined);
        state.signature = undefined;
    }
    if (state.channel)
        state.block++;
    state.channel = undefined;
}
function content(state, out, channel, text) {
    if (!text)
        return;
    if (state.channel && state.channel !== channel)
        closeChannel(state, out);
    state.channel = channel;
    state.hasContent = true;
    state.lifecycle = channel === "text"
        ? Lifecycle.textDelta(state.lifecycle, out, `text-${state.block}`, text)
        : Lifecycle.reasoningDelta(state.lifecycle, out, `reasoning-${state.block}`, text);
}
const REASONING_TAGS = {
    "<thinking>": "</thinking>", "<think>": "</think>",
    "<reasoning>": "</reasoning>", "<thought>": "</thought>",
};
function taggedContent(state, out, text, flush = false) {
    state.pendingText += text;
    while (state.pendingText) {
        const tags = state.closingTag ? [state.closingTag] : Object.keys(REASONING_TAGS);
        let position = -1;
        let matched = "";
        for (const tag of tags) {
            const at = state.pendingText.indexOf(tag);
            if (at >= 0 && (position < 0 || at < position)) {
                position = at;
                matched = tag;
            }
        }
        const channel = state.closingTag ? "reasoning" : "text";
        if (position >= 0) {
            content(state, out, channel, state.pendingText.slice(0, position));
            state.pendingText = state.pendingText.slice(position + matched.length);
            closeChannel(state, out);
            state.closingTag = state.closingTag ? undefined : REASONING_TAGS[matched];
            continue;
        }
        let held = 0;
        if (!flush)
            for (const tag of tags) {
                for (let length = Math.min(tag.length - 1, state.pendingText.length); length > held; length--) {
                    if (state.pendingText.endsWith(tag.slice(0, length))) {
                        held = length;
                        break;
                    }
                }
            }
        const safe = state.pendingText.length - held;
        content(state, out, channel, state.pendingText.slice(0, safe));
        state.pendingText = state.pendingText.slice(safe);
        break;
    }
}
function finishTool(state, out) {
    const tool = state.activeTool;
    if (!tool)
        throw outputError("Kiro ended a tool call without starting one");
    let input;
    try {
        input = JSON.parse(tool.input || "{}");
    }
    catch {
        throw outputError("Kiro returned malformed tool input JSON");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw outputError("Kiro tool input must be a JSON object");
    out.push(LLMEvent.toolInputEnd({ id: tool.id, name: tool.name }));
    out.push(LLMEvent.toolCall({ id: tool.id, name: tool.name, input }));
    state.hasTools = true;
    state.activeTool = undefined;
}
function finishReason(raw, tools) {
    const normalized = /max_tokens|length|token_limit/i.test(raw) ? "length"
        : /content_filter|guardrail|blocked/i.test(raw) ? "content-filter"
            : /tool/i.test(raw) || tools ? "tool-calls" : /error/i.test(raw) ? "error" : "stop";
    return { normalized, raw };
}
export function step(state, event) {
    const out = [];
    const data = event.data;
    if (event.kind === "exception" || event.kind === "error" || ["error", "validationError", "throttlingError", "serviceUnavailableError"].includes(event.type)) {
        throw providerError(event.type, data);
    }
    switch (event.type) {
        case "assistantResponseEvent":
            if (typeof data.content === "string") {
                if (state.tagged)
                    taggedContent(state, out, data.content);
                else
                    content(state, out, "text", data.content);
            }
            break;
        case "reasoningContentEvent":
            if (state.pendingText)
                taggedContent(state, out, "", true);
            state.tagged = false;
            if (typeof data.text === "string")
                content(state, out, "reasoning", data.text);
            if (typeof data.signature === "string")
                state.signature = data.signature;
            if (data.redactedContent !== undefined)
                state.metadata.redactedContent = data.redactedContent;
            break;
        case "toolUseEvent": {
            if (state.pendingText)
                taggedContent(state, out, "", true);
            if (typeof data.toolUseId === "string") {
                if (state.activeTool && state.activeTool.id !== data.toolUseId)
                    throw outputError("Kiro started a tool before completing the previous call");
                if (!state.activeTool) {
                    if (state.toolIDs.has(data.toolUseId))
                        throw outputError("Kiro reused a completed tool-call ID");
                    if (typeof data.name !== "string" || !data.name)
                        throw outputError("Kiro tool call is missing its name");
                    closeChannel(state, out);
                    state.lifecycle = Lifecycle.stepStart(state.lifecycle, out);
                    state.activeTool = { id: data.toolUseId, name: data.name, input: "" };
                    state.toolIDs.add(data.toolUseId);
                    out.push(LLMEvent.toolInputStart({ id: data.toolUseId, name: data.name }));
                }
            }
            const tool = state.activeTool;
            if (!tool)
                throw outputError("Kiro sent tool input without a tool-call ID");
            const fragment = typeof data.input === "string" ? data.input
                : Object.keys(object(data.input)).length ? JSON.stringify(data.input) : "";
            if (fragment) {
                tool.input += fragment;
                out.push(LLMEvent.toolInputDelta({ id: tool.id, name: tool.name, text: fragment }));
            }
            if (data.stop === true)
                finishTool(state, out);
            break;
        }
        case "metadataEvent": {
            const tokens = object(data.tokenUsage);
            const nonCachedInputTokens = number(tokens.uncachedInputTokens);
            const cacheReadInputTokens = number(tokens.cacheReadInputTokens);
            const cacheWriteInputTokens = number(tokens.cacheWriteInputTokens);
            const inputTokens = nonCachedInputTokens === undefined ? undefined
                : nonCachedInputTokens + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
            const outputTokens = number(tokens.outputTokens);
            state.usage = new Usage({ inputTokens, outputTokens, nonCachedInputTokens, cacheReadInputTokens,
                cacheWriteInputTokens, totalTokens: number(tokens.totalTokens) ??
                    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
                providerMetadata: { kiro: { tokenUsage: tokens } },
            });
            if (typeof data.stopReason === "string")
                state.reason = finishReason(data.stopReason, state.hasTools);
            if (data.stopDetails !== undefined)
                state.metadata.stopDetails = data.stopDetails;
            break;
        }
        case "meteringEvent":
            state.metadata.metering = data;
            break;
        case "contextUsageEvent":
            state.metadata.contextUsagePercentage = data.contextUsagePercentage;
            break;
        case "codeReferenceEvent":
        case "documentCitationEvent": {
            const entries = (state.metadata[event.type] ??= []);
            entries.push(data);
            break;
        }
    }
    return [state, out];
}
export function finish(state) {
    if (state.activeTool)
        throw outputError("Kiro stream ended with an unfinished tool call", true);
    const out = [];
    if (state.pendingText)
        taggedContent(state, out, "", true);
    if (!state.hasContent && !state.hasTools && !state.reason)
        throw outputError("Kiro returned an empty response", true);
    closeChannel(state, out);
    const reason = !state.reason
        ? { normalized: state.hasTools ? "tool-calls" : "stop" }
        : state.hasTools && state.reason.normalized === "stop"
            ? { ...state.reason, normalized: "tool-calls" } : state.reason;
    Lifecycle.finish(state.lifecycle, out, { reason, usage: state.usage, providerMetadata: { kiro: state.metadata } });
    return out;
}
