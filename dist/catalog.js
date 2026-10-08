import { Model, Provider } from "@opencode/plugin";
import { authHeaders, resolveProfile } from "./auth.js";
export const PROVIDER_ID = Provider.ID.make("kiro");
export const PROVIDER_PACKAGE = new URL("./provider.js", import.meta.url).href;
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function effortConfig(schema, modelID) {
    if (schema !== undefined && schema !== null) {
        if (!record(schema) || !record(schema.properties))
            return undefined;
        for (const field of ["reasoning", "output_config"]) {
            const fieldSchema = schema.properties[field];
            if (!record(fieldSchema) || !record(fieldSchema.properties))
                continue;
            const effort = fieldSchema.properties.effort;
            if (!record(effort) || !Array.isArray(effort.enum) || !effort.enum.length || !effort.enum.every((value) => typeof value === "string" && value.length > 0))
                continue;
            const thinking = schema.properties.thinking;
            const display = record(thinking) && record(thinking.properties) ? thinking.properties.display : undefined;
            return { field, values: [...new Set(effort.enum)], summarizedThinking: record(display) && Array.isArray(display.enum) && display.enum.includes("summarized") };
        }
        return undefined;
    }
    if (modelID.startsWith("openai-gpt"))
        return { field: "reasoning", values: ["low", "medium", "high", "xhigh"], summarizedThinking: false };
    if (["claude-opus-4.8", "claude-opus-4.7", "claude-sonnet-5", "claude-fable-5"].includes(modelID))
        return { field: "output_config", values: ["low", "medium", "high", "xhigh", "max"], summarizedThinking: true };
    if (["claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.6-1m", "claude-sonnet-4.6-1m"].includes(modelID))
        return { field: "output_config", values: ["low", "medium", "high", "max"], summarizedThinking: false };
    return undefined;
}
export function mapCatalogModels(models) {
    if (!models.length)
        throw new Error("Kiro model catalog is empty");
    const seen = new Set();
    return models.map((entry) => {
        if (typeof entry.modelId !== "string" || !entry.modelId.trim() || entry.modelId.trim() !== entry.modelId || seen.has(entry.modelId))
            throw new Error("Kiro model catalog contains an invalid or duplicate model ID");
        seen.add(entry.modelId);
        const limits = entry.tokenLimits;
        if (limits !== undefined && !record(limits))
            throw new Error("Kiro model catalog contains invalid token limits");
        for (const value of [limits?.maxInputTokens, limits?.maxOutputTokens]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
                throw new Error("Kiro model catalog contains invalid token limits");
        }
        const schema = entry.additionalModelRequestFieldsSchema ?? undefined;
        if (schema !== undefined && !record(schema))
            throw new Error("Kiro model catalog contains an invalid request-fields schema");
        const config = effortConfig(schema, entry.modelId);
        const image = entry.modelId.startsWith("claude-") || entry.modelId.toLowerCase() === "gpt-5.6-luna";
        return {
            ...Model.Info.default(PROVIDER_ID, Model.ID.make(entry.modelId)),
            name: entry.displayName || (entry.modelId === "auto" ? "Kiro Auto" : entry.modelId),
            package: PROVIDER_PACKAGE,
            capabilities: { tools: true, input: image ? ["text", "image"] : ["text"], output: ["text"] },
            limit: { context: limits?.maxInputTokens ?? 200_000, input: limits?.maxInputTokens ?? 200_000, output: limits?.maxOutputTokens ?? 32_000 },
            settings: { ...(schema !== undefined ? { additionalModelRequestFieldsSchema: schema } : {}), ...(config ? { kiroEffort: config } : {}) },
            variants: config ? config.values.map((effort) => ({ id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } })) : [],
        };
    });
}
// Auto is a real service model and the only account-independent offline inventory.
export function bootstrapModels() {
    return mapCatalogModels([{ modelId: "auto", displayName: "Kiro Auto" }]);
}
const catalogs = new Map();
const pendingCatalogs = new Map();
export async function discoverCatalog(credentials) {
    const profile = await resolveProfile(credentials);
    // Catalog entries belong to a regional profile, not to whichever token last requested them.
    const key = `${profile.region}:${profile.profileArn}`;
    const cached = catalogs.get(key);
    if (cached && cached.expires > Date.now())
        return { ...profile, models: cached.models };
    let pending = pendingCatalogs.get(key);
    if (!pending) {
        pending = (async () => {
            const entries = [];
            const pageTokens = new Set();
            let nextToken;
            do {
                const url = new URL(`https://management.${profile.region}.kiro.dev/List-Available-Models`);
                url.searchParams.set("origin", "KIRO_CLI");
                url.searchParams.set("profileArn", profile.profileArn);
                if (nextToken)
                    url.searchParams.set("nextToken", nextToken);
                const response = await fetch(url, { headers: { Accept: "application/json", ...authHeaders(credentials) }, signal: AbortSignal.timeout(15_000) });
                if (!response.ok)
                    throw new Error(`Kiro ListAvailableModels failed (HTTP ${response.status})`);
                const data = await response.json();
                if (!record(data) || !Array.isArray(data.models))
                    throw new Error("Kiro returned an invalid model catalog");
                for (const entry of data.models) {
                    if (!record(entry) || typeof entry.modelId !== "string")
                        throw new Error("Kiro returned an invalid model catalog entry");
                    entries.push(entry);
                }
                nextToken = typeof data.nextToken === "string" && data.nextToken ? data.nextToken : undefined;
                if (nextToken && pageTokens.has(nextToken))
                    throw new Error("Kiro model catalog repeated its pagination token");
                if (nextToken)
                    pageTokens.add(nextToken);
            } while (nextToken);
            const models = mapCatalogModels(entries);
            catalogs.set(key, { expires: Date.now() + 300_000, models });
            return models;
        })();
        pendingCatalogs.set(key, pending);
    }
    try {
        return { ...profile, models: await pending };
    }
    finally {
        if (pendingCatalogs.get(key) === pending)
            pendingCatalogs.delete(key);
    }
}
export async function availableCatalog(credentials) {
    try {
        return { ...await discoverCatalog(credentials), offline: false };
    }
    catch {
        // Never reuse another account's discovery after a failed profile resolution.
        const profile = credentials.profileArn;
        const region = profile?.split(":")[3] || credentials.region;
        const cached = profile ? catalogs.get(`${region}:${profile}`) : undefined;
        return { models: cached?.models ?? bootstrapModels(), profileArn: profile, region, offline: true };
    }
}
