import { afterEach, describe, expect, test } from "bun:test";
import { availableCatalog, bootstrapModels, discoverCatalog, effortConfig, mapCatalogModels } from "../src/catalog.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

describe("Kiro model catalog", () => {
  test("offline bootstrap contains only the real auto service model", () => {
    const models = bootstrapModels();
    expect(models.map((model) => model.modelID)).toEqual(["auto"]);
    expect(models[0]!.package).toMatch(/provider\.js$/);
    expect(models[0]!.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
  });
  test("authoritative schema wins over known-model fallback and preserves effort enums", () => {
    const schema = { properties: { output_config: { properties: { effort: { enum: ["low", "high", "high", "max"] } } }, thinking: { properties: { display: { enum: ["summarized"] } } } } };
    expect(effortConfig(schema, "claude-opus-4.8")).toEqual({ field: "output_config", values: ["low", "high", "max"], summarizedThinking: true });
    expect(effortConfig({}, "claude-opus-4.8")).toBeUndefined();
    expect(effortConfig(undefined, "claude-opus-4.8")!.values).toContain("xhigh");
    expect(effortConfig(undefined, "unknown-model")).toBeUndefined();
  });
  test("discovered models retain service IDs, token limits and native effort variants", () => {
    const schema = { properties: { reasoning: { properties: { effort: { enum: ["medium", "xhigh"] } } } } };
    const [model] = mapCatalogModels([{ modelId: "new-model.1", displayName: "New model", tokenLimits: { maxInputTokens: 12345, maxOutputTokens: 4567 }, additionalModelRequestFieldsSchema: schema }]);
    expect(model!.id).toBe("new-model.1");
    expect(model!.modelID).toBe("new-model.1");
    expect(model!.limit).toEqual({ context: 12345, input: 12345, output: 4567 });
    expect(model!.settings!.additionalModelRequestFieldsSchema).toEqual(schema);
    expect(model!.variants.map((variant) => variant.settings!.reasoningEffort)).toEqual(["medium", "xhigh"]);
    expect(mapCatalogModels([{ modelId: "claude-sonnet-4.6" }])[0]!.capabilities.input).toContain("image");
    expect(mapCatalogModels([{ modelId: "unknown-vision" }])[0]!.capabilities.input).toEqual(["text"]);
  });
  test("catalog rejects invalid limits, duplicate IDs and malformed metadata", () => {
    expect(() => mapCatalogModels([])).toThrow("empty");
    expect(() => mapCatalogModels([{ modelId: "auto" }, { modelId: "auto" }])).toThrow("duplicate");
    expect(() => mapCatalogModels([{ modelId: "auto", tokenLimits: { maxOutputTokens: -1 } }])).toThrow("token limits");
    expect(() => mapCatalogModels([{ modelId: "auto", additionalModelRequestFieldsSchema: [] as unknown as Record<string, unknown> }])).toThrow("schema");
  });
  test("discovery is single flight per profile and region, not shared between accounts", async () => {
    const a = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/catalog-a";
    const b = "arn:aws:codewhisperer:us-east-1:000000000000:profile/catalog-b";
    const urls: string[] = [];
    mockFetch((url, init) => {
      urls.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer /);
      return Response.json({ models: [{ modelId: url.includes("catalog-a") ? "account-a-model" : "account-b-model" }] });
    });
    const [first, second] = await Promise.all([discoverCatalog({ access: "token-a", region: "us-east-1", profileArn: a }), discoverCatalog({ access: "token-a2", region: "us-east-1", profileArn: a })]);
    expect(first.models).toBe(second.models);
    expect(first.region).toBe("eu-central-1");
    const other = await discoverCatalog({ access: "token-b", region: "eu-central-1", profileArn: b });
    expect(other.models[0]!.id).toBe("account-b-model");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("management.eu-central-1");
    expect(urls[1]).toContain("management.us-east-1");
  });
  test("pagination keeps server metadata and rejects loops", async () => {
    let requests = 0;
    mockFetch((url) => {
      requests++;
      return url.includes("nextToken") ? Response.json({ models: [{ modelId: "page-two" }] }) : Response.json({ models: [{ modelId: "page-one" }], nextToken: "next" });
    });
    const result = await discoverCatalog({ access: "paging", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/paging" });
    expect(result.models.map((model) => model.id)).toEqual(["page-one", "page-two"]);
    expect(requests).toBe(2);
    mockFetch(() => Response.json({ models: [{ modelId: "loop" }], nextToken: "loop-token" }));
    await expect(discoverCatalog({ access: "loop", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/loop" })).rejects.toThrow("pagination");
  });
  test("offline discovery never leaks another account's catalog", async () => {
    mockFetch(() => { throw new Error("offline"); });
    const result = await availableCatalog({ access: "offline", region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/offline" });
    expect(result.offline).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(["auto"]);
    expect(result.profileArn).toContain("offline");
  });
});
