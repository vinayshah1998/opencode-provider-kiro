import { afterEach, expect, test } from "bun:test";
import { Credential, Integration, Model } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { IntegrationMethodRegistration } from "@opencode/plugin/promise/integration";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { SessionHooks } from "@opencode/plugin/promise/session";
import { KiroPlugin } from "../src/plugin.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.KIRO_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.KIRO_API_KEY; else process.env.KIRO_API_KEY = originalKey;
});

test("plugin registers native inventory and connection methods without startup login", async () => {
  delete process.env.KIRO_API_KEY;
  let networkCalls = 0;
  globalThis.fetch = (() => { networkCalls++; throw new Error("startup must not request"); }) as typeof fetch;
  const methods: IntegrationMethodRegistration[] = [];
  const hooks = new Map<string, (event: never) => Promise<void>>();
  let provider: Parameters<ProviderEditor["add"]>[0] | undefined;
  let disposed = 0;
  const registration = async () => ({ dispose: async () => { disposed++; } });
  const ctx = {
    provider: { transform: async (callback: (editor: unknown) => void) => {
      callback({ get: () => undefined, add: (input: Parameters<ProviderEditor["add"]>[0]) => { provider = input; } });
      return registration();
    }, reload: async () => {}, get: async () => ({ data: provider!.info }) },
    integration: { transform: async (callback: (editor: unknown) => void) => {
      callback({ method: { update: (method: IntegrationMethodRegistration) => methods.push(method) } });
      return registration();
    }, connection: { active: async () => undefined, resolve: async () => undefined } },
    session: { hook: async (name: string, callback: (event: never) => Promise<void>, options: { providerID: string }) => {
      expect(options.providerID).toBe("kiro"); hooks.set(name, callback); return registration();
    } },
  } as unknown as Plugin.Context;
  const cleanup = await KiroPlugin.setup(ctx);
  expect(networkCalls).toBe(0);
  expect(provider!.info.package).toMatch(/^file:.*provider\.js$/);
  expect(provider!.models.map((model) => model.id)).toEqual(["auto"]);
  expect(methods.filter((method) => method.method.type === "oauth").map((method) => "id" in method.method ? method.method.id : "")).toEqual(["builder-id", "identity-center", "reuse-cli", "reuse-ide", "reuse-external-idp", "google", "github"]);
  expect(methods.some((method) => method.method.type === "env")).toBe(true);
  expect(hooks.has("http.request")).toBe(true);
  await cleanup?.();
  expect(disposed).toBe(4);
});

test("final HTTP hook uses host-resolved fresh token, profile and region without inventory secrets", async () => {
  delete process.env.KIRO_API_KEY;
  const profileArn = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/plugin";
  let current: Credential.Value = { type: "oauth", methodID: Integration.MethodID.make("builder-id"), access: "startup-access", refresh: "refresh", expires: Date.now() + 3600000, metadata: { region: "us-east-1", profileArn } };
  const methods: IntegrationMethodRegistration[] = [];
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  let provider: Parameters<ProviderEditor["add"]>[0] | undefined;
  globalThis.fetch = (async () => Response.json({ models: [{ modelId: "auto" }] })) as typeof fetch;
  const registration = async () => ({ dispose: async () => {} });
  let transform: ((editor: unknown) => void) | undefined;
  const editor = { get: () => undefined, add: (input: Parameters<ProviderEditor["add"]>[0]) => { provider = input; } };
  const ctx = {
    provider: { transform: async (callback: (input: unknown) => void) => { transform = callback; callback(editor); return registration(); }, reload: async () => { transform?.(editor); }, get: async () => ({ data: provider!.info }) },
    integration: { transform: async (callback: (input: unknown) => void) => { callback({ method: { update: (method: IntegrationMethodRegistration) => methods.push(method) } }); return registration(); }, connection: {
      active: async () => ({ type: "credential", id: Credential.ID.make("crd_plugin"), label: "Kiro", method: "oauth" }), resolve: async () => current,
    } },
    session: { hook: async (name: string, callback: (event: unknown) => Promise<void>) => { hooks.set(name, callback); return registration(); } },
  } as unknown as Plugin.Context;
  const cleanup = await KiroPlugin.setup(ctx);
  expect(provider!.info.settings).toEqual({ region: "eu-central-1", profileArn });
  expect(JSON.stringify(provider)).not.toContain("startup-access");
  expect(JSON.stringify(provider)).not.toContain('"refresh"');
  current = { ...current, access: "fresh-access" };
  const event = {
    sessionID: "session", agent: "agent", kind: "primary", model: { providerID: "kiro", id: Model.ID.make("auto") },
    request: new Request("https://runtime.us-east-1.kiro.dev/generateAssistantResponse", { method: "POST", headers: { Authorization: "Bearer stale-access", tokentype: "API_KEY", "Content-Type": "application/json" }, body: JSON.stringify({ conversationState: { value: 1 }, profileArn: "old-profile" }) }),
  } as unknown as SessionHooks["http.request"];
  await hooks.get("http.request")!(event);
  expect(event.request.url).toContain("runtime.eu-central-1.kiro.dev");
  expect(event.request.headers.get("Authorization")).toBe("Bearer fresh-access");
  expect(event.request.headers.get("tokentype")).toBeNull();
  expect(await event.request.json()).toEqual({ conversationState: { value: 1 }, profileArn });
  const unsafe = { ...event, request: new Request("https://third-party.example.test/", { method: "POST", body: "{}" }) };
  await expect(hooks.get("http.request")!(unsafe)).rejects.toThrow("unrecognized");
  await cleanup?.();
});

test("runtime uses final provider settings applied after source registration", async () => {
  delete process.env.KIRO_API_KEY;
  const profileArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/settings";
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  let info: Record<string, unknown> = {};
  const registration = () => ({ dispose: async () => {} });
  globalThis.fetch = (async () => Response.json({ models: [{ modelId: "auto" }] })) as typeof fetch;
  const ctx = {
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ get: () => undefined, add: (entry: Parameters<ProviderEditor["add"]>[0]) => { info = entry.info; } });
        return registration();
      },
      get: async () => ({ data: { ...info, settings: { apiKey: "configured-key", region: "us-east-1", profileArn } } }),
      reload: async () => {},
    },
    integration: { transform: async (callback: (editor: unknown) => void) => {
      callback({ method: { update: () => {} } }); return registration();
    }, connection: { active: async () => undefined } },
    session: { hook: async (name: string, callback: (event: unknown) => Promise<void>) => { hooks.set(name, callback); return registration(); } },
  } as unknown as Plugin.Context;
  const cleanup = await KiroPlugin.setup(ctx);
  const event = { headers: {} as Record<string, string>, baseURL: "" };
  await hooks.get("model.request")!(event);
  expect(event.headers.Authorization).toBe("Bearer configured-key");
  expect(event.baseURL).toBe("https://runtime.us-east-1.kiro.dev/");
  await cleanup?.();
});
