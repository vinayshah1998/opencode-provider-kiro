import { Effect, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import {
  AIError, AuthenticationError, InvalidRequestError, type LLMRequest,
  type ProviderPackageSettings,
} from "@opencode/ai";
import { Auth, Endpoint, HttpTransport, Protocol, Route, type TransportDef } from "@opencode/ai/route";
import { authHeaders, resolveCredentials, resolveProfile, type KiroCredentials } from "./auth.js";
import { buildConversation } from "./transform.js";
import { WireEvent, finish, framing, initial, outputError, providerError, step, type ParserState } from "./stream.js";

export interface KiroSettings extends ProviderPackageSettings {
  readonly apiKey?: string;
  readonly region?: string;
  readonly profileArn?: string;
}
interface RequestIdentity {
  credentials: KiroCredentials;
  profileArn: string;
  region: string;
}
const Body = Schema.Record(Schema.String, Schema.Unknown);

function requestError(error: unknown): AIError {
  return error instanceof AIError ? error : new AIError({ reason: new InvalidRequestError({
    message: error instanceof Error ? error.message : "Unable to construct Kiro request",
  }) });
}

/** OpenCode 2.0.23 native provider-package entrypoint. No nested CLI agent. */
export function model(modelID: string, settings: KiroSettings = {}) {
  // Identity is per request: concurrent sessions cannot mix a token with another profile.
  const identities = new WeakMap<object, RequestIdentity>();
  const identity = (request: object) => {
    const value = identities.get(request);
    if (!value) throw new Error("Kiro request identity was not initialized");
    return value;
  };
  const {
    apiKey: _apiKey, refresh: _refresh, clientSecret: _clientSecret,
    headers, body, baseURL, ...providerOptions
  } = settings;
  const protocol = Protocol.make({
    id: "kiro",
    body: {
      schema: Body,
      from: (request: LLMRequest) => Effect.tryPromise({
        try: async () => {
          const conversation = await buildConversation(request);
          let credentials: KiroCredentials;
          try { credentials = await resolveCredentials(settings); }
          catch (error) {
            throw new AIError({ reason: new AuthenticationError({
              message: error instanceof Error ? error.message : "Kiro authentication failed",
            }) });
          }
          const profile = await resolveProfile(credentials);
          identities.set(request, { credentials, ...profile });
          return { ...conversation, profileArn: profile.profileArn, agentMode: "vibe" };
        },
        catch: requestError,
      }),
    },
    stream: {
      event: WireEvent,
      initial: (request: LLMRequest) => {
        const effort = request.providerOptions?.reasoningEffort ?? request.providerOptions?.reasoning;
        return initial(effort !== undefined && effort !== "none" && effort !== "off");
      },
      step: (state: ParserState, event: WireEvent) => Effect.try({
        try: () => step(state, event),
        catch: (error) => error instanceof AIError ? error : outputError("Invalid Kiro stream event"),
      }),
      onHalt: (state: ParserState) => Effect.try({
        try: () => finish(state),
        catch: (error) => error instanceof AIError ? error : outputError("Unable to complete Kiro response"),
      }),
    },
  });
  const transport = HttpTransport.httpJson<Record<string, unknown>, WireEvent>({ framing });
  const kiroTransport: TransportDef<Record<string, unknown>, HttpTransport.HttpPrepared<WireEvent>, WireEvent> = {
    ...transport,
    prepare: (input) => transport.prepare({
      ...input,
      endpoint: Endpoint.path("/generateAssistantResponse", {
        baseURL: baseURL ?? `https://runtime.${identity(input.request).region}.kiro.dev`,
      }),
    }),
    execute: (prepared, request, runtime, options) => transport.execute(prepared, request, runtime, options).pipe(
      Effect.mapError((error) => {
        const status = error.reason.http?.status;
        if (!status) return error;
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(error.reason.body ?? "{}"); } catch { /* Keep native HTTP error below. */ }
        if (!data.reason) return error;
        const mapped = providerError(String(data.__type ?? data.name ?? "Kiro request failed"), data, status);
        return new AIError({ reason: { ...mapped.reason, http: error.reason.http } });
      }),
    ),
  };
  const route = Route.make({
    id: "kiro",
    provider: "kiro",
    protocol,
    endpoint: Endpoint.path("/generateAssistantResponse", { baseURL: baseURL ?? "https://runtime.us-east-1.kiro.dev" }),
    auth: Auth.custom((input) => Effect.sync(() => Headers.fromInput({
      ...input.headers,
      ...headers,
      ...authHeaders(identity(input.request).credentials),
      "content-type": "application/json",
      accept: "application/vnd.amazon.eventstream",
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "amz-sdk-invocation-id": crypto.randomUUID(),
      "amz-sdk-request": "attempt=1; max=1",
      "user-agent": "opencode-provider-kiro/0.1.0",
      "x-amz-user-agent": "opencode-provider-kiro/0.1.0",
    }))),
    transport: kiroTransport,
    defaults: { providerOptions, ...(body ? { http: { body: { ...body } } } : {}) },
  });
  return route.model({ id: modelID });
}
