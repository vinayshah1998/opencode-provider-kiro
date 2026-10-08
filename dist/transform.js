import { createHash, randomUUID } from "node:crypto";
import { Media } from "@opencode/ai/media";
import { RequestExecutor } from "@opencode/ai/route";
import { AIError, InvalidRequestError, } from "@opencode/ai";
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "effect";
import { effortConfig } from "./catalog.js";
const EMPTY_CONTENT = "Please proceed with the task.";
const VALID_TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;
const GENERATION_FIELDS = {
    maxTokens: ["max_tokens", "maxTokens"],
    temperature: ["temperature"],
    topP: ["top_p", "topP"],
    topK: ["top_k", "topK"],
    frequencyPenalty: ["frequency_penalty", "frequencyPenalty"],
    presencePenalty: ["presence_penalty", "presencePenalty"],
    seed: ["seed"],
    stop: ["stop_sequences", "stopSequences", "stop"],
};
function invalid(message, parameter) {
    throw new AIError({ reason: new InvalidRequestError({ message: `Kiro: ${message}`, parameter }) });
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function join(left, right) {
    return left && right ? `${left}\n\n${right}` : left || right;
}
function valueText(value) {
    if (typeof value === "string")
        return value;
    if (value instanceof Error)
        return value.message;
    try {
        const text = JSON.stringify(value);
        if (text !== undefined)
            return text;
    }
    catch {
        invalid("tool output is not JSON serializable", "messages");
    }
    invalid("tool output is not JSON serializable", "messages");
}
/** Keep Kiro IDs unchanged and consistently remap other providers' opaque IDs. */
export function toKiroToolUseId(id) {
    return VALID_TOOL_ID.test(id) ? id : `oc_${createHash("sha256").update(id).digest("base64url")}`;
}
async function image(asset) {
    if (asset.source.type === "ref")
        invalid("provider media references cannot be sent as Kiro images", "messages");
    let inline = asset.inline();
    if (!inline) {
        const materialized = await Effect.runPromise(asset.materialize().pipe(Effect.provide(RequestExecutor.fetchLayer)));
        inline = materialized.inline();
    }
    if (!inline)
        invalid("image could not be materialized", "messages");
    const mime = inline.mime.split(";", 1)[0].trim();
    const format = { "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif", "image/webp": "webp" }[mime];
    if (!format)
        invalid(`unsupported media type ${mime}; Kiro accepts PNG, JPEG, GIF, and WebP images`, "messages");
    return { format, source: { bytes: inline.base64 } };
}
async function resultAtom(part) {
    if (part.namespace !== undefined)
        invalid("namespaced tool results are unsupported", "messages");
    const content = [];
    const images = [];
    if (part.result.type === "content") {
        for (const item of part.result.value) {
            if (item.type === "text") {
                content.push({ text: item.text });
            }
            else {
                const parsed = Media.parseDataUrl(item.uri);
                const asset = parsed
                    ? Media.from({ ...parsed.source, mediaType: item.mime })
                    : /^https?:\/\//i.test(item.uri)
                        ? Media.url(item.uri, { mediaType: item.mime })
                        : Media.base64(item.uri, item.mime);
                images.push(await image(asset));
            }
        }
    }
    else {
        content.push({ text: valueText(part.result.value) });
    }
    // Keep empty outputs empty; Kiro's result carrier needs no invented success text.
    if (content.length === 0)
        content.push({ text: "" });
    return {
        role: "result", part, images,
        result: { toolUseId: toKiroToolUseId(part.id), status: part.result.type === "error" ? "error" : "success", content },
    };
}
function toolInput(input) {
    if (typeof input === "string") {
        try {
            input = JSON.parse(input);
        }
        catch {
            invalid("tool call input must be a JSON object", "messages");
        }
    }
    if (!record(input))
        invalid("tool call input must be a JSON object", "messages");
    return input;
}
async function lowerMessages(request) {
    const atoms = [];
    for (const message of request.messages) {
        let content = "";
        let summary = "";
        let meaningful = false;
        const images = [];
        const calls = [];
        const results = [];
        for (const part of message.content) {
            switch (part.type) {
                case "text":
                    content += part.text;
                    meaningful = true;
                    break;
                case "compaction":
                    if (part.encrypted !== undefined)
                        invalid("encrypted compaction cannot be replayed to Kiro; provide a plaintext summary", "messages");
                    // A null summary means compaction failed. Keep the rest of the supplied history.
                    if (part.text !== null && part.text !== undefined) {
                        if (message.role === "assistant")
                            summary = join(summary, part.text);
                        else {
                            content = join(content, part.text);
                            meaningful = true;
                        }
                    }
                    break;
                case "effort":
                    if (message.role !== "system")
                        invalid("effort markers require the system role", "messages");
                    break;
                case "reasoning":
                    if (message.role !== "assistant")
                        invalid("reasoning content requires the assistant role", "messages");
                    // The reference Kiro transport does not replay signatures/reasoningContent.
                    // Never flatten private reasoning or encrypted signatures into assistant speech.
                    meaningful = true;
                    break;
                case "media":
                    if (message.role !== "user" && message.role !== "tool")
                        invalid("Kiro accepts images only in user/tool turns", "messages");
                    images.push(await image(part.media));
                    meaningful = true;
                    break;
                case "tool-call":
                    if (message.role !== "assistant")
                        invalid("tool calls require the assistant role", "messages");
                    if (part.namespace !== undefined)
                        invalid("namespaced tool calls are unsupported", "messages");
                    calls.push({ originalId: part.id, use: { name: part.name, toolUseId: toKiroToolUseId(part.id), input: toolInput(part.input) } });
                    meaningful = true;
                    break;
                case "tool-result":
                    results.push(part);
                    break;
            }
        }
        if (summary)
            atoms.push({ role: "user", content: summary, images: [] });
        if (message.role === "assistant" && meaningful) {
            atoms.push({ role: "assistant", content, calls });
        }
        else if (message.role === "user" || (message.role === "system" && meaningful) || (message.role === "tool" && (content || images.length))) {
            atoms.push({ role: "user", content, images });
        }
        if (message.role === "tool" && results.length === 0 && message.content.length) {
            invalid("tool messages must include a tool-result with its actual call ID", "messages");
        }
        for (const part of results)
            atoms.push(await resultAtom(part));
    }
    return atoms;
}
/** Reorder only displaced results, retaining every real output and user interjection. */
function pairResults(atoms, modelId) {
    const calls = new Map();
    const results = new Map();
    const mappedIDs = new Map();
    for (let index = 0; index < atoms.length; index++) {
        const atom = atoms[index];
        if (atom.role === "assistant") {
            for (const { originalId, use } of atom.calls) {
                if (calls.has(originalId))
                    invalid(`duplicate tool call ID ${originalId}`, "messages");
                const previousID = mappedIDs.get(use.toolUseId);
                if (previousID !== undefined && previousID !== originalId)
                    invalid("tool ID mapping collision", "messages");
                mappedIDs.set(use.toolUseId, originalId);
                calls.set(originalId, { index, name: use.name });
            }
        }
        else if (atom.role === "result") {
            const call = calls.get(atom.part.id);
            if (!call)
                invalid(`tool result ${atom.part.id} has no preceding tool call`, "messages");
            if (call.name !== atom.part.name)
                invalid(`tool result ${atom.part.id} does not match its tool name`, "messages");
            if (results.has(atom.part.id))
                invalid(`duplicate tool result ID ${atom.part.id}`, "messages");
            results.set(atom.part.id, atom);
        }
    }
    for (const id of calls.keys()) {
        if (!results.has(id))
            invalid(`tool call ${id} has no result; missing results are never synthesized`, "messages");
    }
    const entries = [];
    const appendUser = (content, images, toolResults) => {
        const previous = entries.at(-1);
        if (previous && "userInputMessage" in previous) {
            const user = previous.userInputMessage;
            user.content = join(user.content, content);
            if (images.length)
                (user.images ??= []).push(...images);
            if (toolResults?.length)
                ((user.userInputMessageContext ??= {}).toolResults ??= []).push(...toolResults);
        }
        else {
            entries.push({ userInputMessage: {
                    content, modelId, origin: "KIRO_CLI",
                    ...(images.length ? { images } : {}),
                    ...(toolResults?.length ? { userInputMessageContext: { toolResults } } : {}),
                } });
        }
    };
    for (const atom of atoms) {
        if (atom.role === "result")
            continue;
        if (atom.role === "user") {
            appendUser(atom.content, atom.images);
            continue;
        }
        const previous = entries.at(-1);
        if (previous && "assistantResponseMessage" in previous) {
            const assistant = previous.assistantResponseMessage;
            assistant.content = join(assistant.content, atom.content);
            if (atom.calls.length)
                (assistant.toolUses ??= []).push(...atom.calls.map((call) => call.use));
        }
        else {
            entries.push({ assistantResponseMessage: {
                    content: atom.content,
                    ...(atom.calls.length ? { toolUses: atom.calls.map((call) => call.use) } : {}),
                } });
        }
        if (atom.calls.length) {
            const answered = atom.calls.map((call) => results.get(call.originalId));
            appendUser("", answered.flatMap((result) => result.images), answered.map((result) => result.result));
        }
    }
    return entries;
}
function validateFields(schema, fields) {
    if (schema === undefined || schema === null) {
        for (const key of Object.keys(fields)) {
            if (!["reasoning", "output_config", "thinking"].includes(key)) {
                invalid(`additionalModelRequestFields.${key} requires the model's catalog schema`, "providerOptions.additionalModelRequestFields");
            }
        }
        return;
    }
    if (!record(schema))
        invalid("additionalModelRequestFieldsSchema must be a JSON Schema object", "providerOptions.additionalModelRequestFieldsSchema");
    const properties = record(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(fields)) {
        if (properties[key] === undefined)
            invalid(`additionalModelRequestFields.${key} is not advertised by the model's catalog schema`, "providerOptions.additionalModelRequestFields");
    }
    try {
        const document = schema.$schema === JsonSchema.META_SCHEMA_URI_DRAFT_07
            ? JsonSchema.fromSchemaDraft07(schema)
            : JsonSchema.fromSchemaDraft2020_12(schema);
        const validator = SchemaRepresentation.fromJsonSchemaDocument(document);
        if (!Schema.is(validator)(fields))
            invalid("additionalModelRequestFields do not match the selected model's catalog schema", "providerOptions.additionalModelRequestFields");
    }
    catch (error) {
        if (error instanceof AIError)
            throw error;
        invalid("additionalModelRequestFields catalog schema cannot be validated", "providerOptions.additionalModelRequestFieldsSchema");
    }
}
function modelFields(request, options) {
    const schema = options.additionalModelRequestFieldsSchema;
    const provided = options.additionalModelRequestFields;
    if (provided !== undefined && !record(provided))
        invalid("additionalModelRequestFields must be an object", "providerOptions.additionalModelRequestFields");
    const fields = { ...provided };
    const properties = record(schema) && record(schema.properties) ? schema.properties : {};
    const generation = { ...request.model.route.defaults.generation, ...request.model.defaults?.generation, ...request.generation };
    for (const [key, value] of Object.entries(generation)) {
        if (value === undefined)
            continue;
        const nativeKey = GENERATION_FIELDS[key]?.find((candidate) => properties[candidate] !== undefined);
        if (nativeKey) {
            if (fields[nativeKey] !== undefined && JSON.stringify(fields[nativeKey]) !== JSON.stringify(value))
                invalid(`conflicting generation.${key} and additionalModelRequestFields.${nativeKey}`, `generation.${key}`);
            fields[nativeKey] = value;
        }
        else if (["maxTokens", "temperature", "topP"].includes(key)) {
            // OpenCode supplies these defaults even when an upstream has no corresponding knobs.
            console.warn(`[opencode-provider-kiro] generation.${key} is not advertised by the Kiro catalog and cannot be applied.`);
        }
        else {
            invalid(`unsupported generation option ${key}; the selected model's catalog has no matching field`, `generation.${key}`);
        }
    }
    let level = options.reasoningEffort ?? options.reasoning;
    if (options.reasoningEffort !== undefined && options.reasoning !== undefined && options.reasoningEffort !== options.reasoning)
        invalid("reasoningEffort and reasoning conflict", "providerOptions.reasoningEffort");
    if (record(level)) {
        if (Object.keys(level).some((key) => key !== "effort" && key !== "enabled"))
            invalid("unsupported reasoning option; use reasoningEffort", "providerOptions.reasoning");
        if (level.enabled !== undefined && typeof level.enabled !== "boolean")
            invalid("reasoning.enabled must be boolean", "providerOptions.reasoning");
        if (level.enabled === true && level.effort === undefined)
            invalid("reasoning.enabled requires an explicit supported effort", "providerOptions.reasoning");
        level = level.enabled === false ? "none" : level.effort;
    }
    if (level === undefined) {
        for (const message of request.messages) {
            for (const part of message.content)
                if (part.type === "effort")
                    level = part.effort;
        }
    }
    if (level !== undefined && typeof level !== "string")
        invalid("reasoningEffort must be a string", "providerOptions.reasoningEffort");
    let config = effortConfig(schema, request.model.id);
    if (schema === undefined && record(options.kiroEffort)) {
        const supplied = options.kiroEffort;
        if ((supplied.field !== "reasoning" && supplied.field !== "output_config") || !Array.isArray(supplied.values) || !supplied.values.length || !supplied.values.every((item) => typeof item === "string" && item.length) || typeof supplied.summarizedThinking !== "boolean") {
            invalid("kiroEffort metadata is invalid", "providerOptions.kiroEffort");
        }
        config = { field: supplied.field, values: supplied.values, summarizedThinking: supplied.summarizedThinking };
    }
    let thinkingPrompt;
    if (typeof level === "string" && level !== "none" && level !== "off") {
        if (!config)
            invalid("the selected model does not advertise configurable reasoning effort", "providerOptions.reasoningEffort");
        const order = ["low", "medium", "high", "xhigh", "max"];
        const target = level === "minimal" ? "low" : level;
        let effort = config.values.includes(target) ? target : undefined;
        const index = order.indexOf(target);
        if (!effort && index >= 0) {
            const effortValues = config.values;
            effort = order.slice(index).find((candidate) => effortValues.includes(candidate))
                ?? order.slice(0, index).reverse().find((candidate) => effortValues.includes(candidate));
        }
        if (!effort)
            invalid(`unsupported reasoning effort ${level}`, "providerOptions.reasoningEffort");
        const existing = fields[config.field];
        if (existing !== undefined && (!record(existing) || (existing.effort !== undefined && existing.effort !== effort)))
            invalid("reasoningEffort conflicts with additionalModelRequestFields", "providerOptions.reasoningEffort");
        fields[config.field] = { ...(record(existing) ? existing : {}), effort };
        if (config.field === "output_config") {
            const thinking = fields.thinking;
            if (thinking !== undefined && (!record(thinking) || thinking.type !== "adaptive"))
                invalid("reasoningEffort conflicts with thinking configuration", "providerOptions.additionalModelRequestFields");
            fields.thinking = { ...(record(thinking) ? thinking : {}), type: "adaptive", ...(config.summarizedThinking ? { display: "summarized" } : {}) };
            const budget = ["xhigh", "max"].includes(effort) ? 50000 : effort === "high" ? 30000 : effort === "medium" ? 20000 : 10000;
            thinkingPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }
    }
    else if (level === "none" || level === "off") {
        if (fields.reasoning !== undefined || fields.output_config !== undefined || fields.thinking !== undefined)
            invalid("disabled reasoning conflicts with additionalModelRequestFields", "providerOptions.reasoningEffort");
    }
    if (Object.keys(fields).length) {
        if (schema === undefined || schema === null) {
            for (const [key, value] of Object.entries(fields)) {
                if (key === "reasoning" || key === "output_config") {
                    if (!config || key !== config.field || !record(value) || Object.keys(value).some((field) => field !== "effort") || typeof value.effort !== "string" || !config.values.includes(value.effort)) {
                        invalid(`unsupported additionalModelRequestFields.${key} configuration`, "providerOptions.additionalModelRequestFields");
                    }
                }
                else if (key === "thinking") {
                    if (config?.field !== "output_config" || !record(value) || value.type !== "adaptive" || Object.keys(value).some((field) => field !== "type" && field !== "display") || (value.display !== undefined && (value.display !== "summarized" || !config.summarizedThinking))) {
                        invalid("unsupported additionalModelRequestFields.thinking configuration", "providerOptions.additionalModelRequestFields");
                    }
                }
            }
        }
        validateFields(schema, fields);
        return { fields, thinkingPrompt };
    }
    return {};
}
export async function buildConversation(request) {
    // Runtime merges these; also honor defaults for direct consumers of this helper.
    const options = { ...request.model.route.defaults.providerOptions, ...request.model.defaults?.providerOptions, ...request.providerOptions };
    const choice = request.toolChoice;
    if (choice && (choice.type === "required" || choice.type === "tool" || choice.disableParallelToolUse === true)) {
        invalid("Kiro does not support forced tool selection or disabling parallel tool use", "toolChoice");
    }
    const tools = [];
    const toolNames = new Set();
    for (const tool of request.tools) {
        if (tool.type === "namespace")
            invalid("Kiro does not support tool namespaces", "tools");
        if (toolNames.has(tool.name))
            invalid(`duplicate tool definition ${tool.name}`, "tools");
        if (tool.native && Object.keys(tool.native).length)
            invalid("native provider-specific tool definitions are unsupported", "tools");
        toolNames.add(tool.name);
        if (choice?.type !== "none")
            tools.push({ toolSpecification: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } });
    }
    const { fields, thinkingPrompt } = modelFields(request, options);
    const entries = pairResults(await lowerMessages(request), request.model.id);
    let system = request.system.map((part) => part.text).filter(Boolean).join("\n\n");
    if (thinkingPrompt)
        system = join(thinkingPrompt, system);
    if (entries.length === 0)
        entries.push({ userInputMessage: { content: system || EMPTY_CONTENT, modelId: request.model.id, origin: "KIRO_CLI" } });
    else if ("userInputMessage" in entries[0])
        entries[0].userInputMessage.content = join(system, entries[0].userInputMessage.content);
    else if (system)
        entries.unshift({ userInputMessage: { content: system, modelId: request.model.id, origin: "KIRO_CLI" } });
    else
        invalid("conversation must begin with a user/system message or plaintext summary", "messages");
    const historicalNames = new Set();
    for (const entry of entries) {
        if ("assistantResponseMessage" in entry) {
            for (const use of entry.assistantResponseMessage.toolUses ?? [])
                historicalNames.add(use.name);
        }
        else if (!entry.userInputMessage.content && !entry.userInputMessage.userInputMessageContext?.toolResults?.length) {
            entry.userInputMessage.content = EMPTY_CONTENT;
        }
    }
    if (choice?.type === "none" && historicalNames.size)
        invalid("toolChoice none cannot be enforced while replaying Kiro tool history", "toolChoice");
    // Kiro validates historical uses against the transmitted catalog. These specs
    // describe real historical calls, not synthesized executions or results.
    for (const name of historicalNames) {
        if (!toolNames.has(name))
            tools.push({ toolSpecification: { name, description: "Historical tool; no longer available for execution.", inputSchema: { json: { type: "object", properties: {}, additionalProperties: true } } } });
    }
    let last = entries.at(-1);
    if ("assistantResponseMessage" in last) {
        last = { userInputMessage: { content: EMPTY_CONTENT, modelId: request.model.id, origin: "KIRO_CLI" } };
        entries.push(last);
    }
    const current = last.userInputMessage;
    if (tools.length)
        (current.userInputMessageContext ??= {}).tools = tools;
    const conversationId = options.conversationId ?? options.sessionId ?? randomUUID();
    if (typeof conversationId !== "string" || !conversationId)
        invalid("conversationId/sessionId must be a nonempty string", "providerOptions.conversationId");
    return {
        conversationState: {
            conversationId, chatTriggerType: "MANUAL", agentTaskType: "vibe",
            currentMessage: { userInputMessage: current },
            ...(entries.length > 1 ? { history: entries.slice(0, -1) } : {}),
        },
        ...(fields ? { additionalModelRequestFields: fields } : {}),
    };
}
