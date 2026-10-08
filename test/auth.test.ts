import { afterEach, describe, expect, test } from "bun:test";
import { authHeaders, credentialsFromLocal, deviceAuthorization, refreshCredentials, resolveCredentials, resolveProfile } from "../src/auth.js";
import { fromHostCredential, toHostCredential } from "../src/plugin.js";

const originalFetch = globalThis.fetch;
const originalEnv = { key: process.env.KIRO_API_KEY, profile: process.env.KIRO_PROFILE_ARN, region: process.env.KIRO_REGION };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [["KIRO_API_KEY", originalEnv.key], ["KIRO_PROFILE_ARN", originalEnv.profile], ["KIRO_REGION", originalEnv.region]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

 describe("Kiro authentication", () => {
  test("explicit access wins over environment and opaque host OAuth is not a fake API key", async () => {
    process.env.KIRO_API_KEY = "ksk_environment";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/env";
    const credentials = await resolveCredentials({ apiKey: "host-oauth", region: "us-west-2", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/explicit" });
    expect(credentials.access).toBe("host-oauth");
    expect(credentials.profileArn).toContain("explicit");
    expect(authHeaders(credentials)).toEqual({ Authorization: "Bearer host-oauth" });
    expect(authHeaders(await resolveCredentials({})).tokentype).toBe("API_KEY");
  });
  test("unconnected resolution does not silently reuse local credentials", async () => {
    delete process.env.KIRO_API_KEY;
    await expect(resolveCredentials({})).rejects.toThrow("not connected");
  });
  test("external JWT audience and explicit family produce required token type", () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ aud: "api://kiro" })).toString("base64url")}.signature`;
    expect(authHeaders({ access: jwt, region: "us-east-1" }).tokentype).toBe("EXTERNAL_IDP");
    expect(authHeaders({ access: "opaque", region: "us-east-1", authMethod: "external-idp" }).tokentype).toBe("EXTERNAL_IDP");
    expect(authHeaders({ access: "header.invalid.signature", region: "us-east-1" }).tokentype).toBeUndefined();
  });
  test("refresh is single flight and retains rotated tokens and account metadata", async () => {
    const gate = Promise.withResolvers<Response>();
    let calls = 0;
    mockFetch((url, init) => {
      calls++;
      expect(url).toBe("https://oidc.eu-west-2.amazonaws.com/token");
      expect(JSON.parse(String(init?.body))).toMatchObject({ grantType: "refresh_token", refreshToken: "single-flight-refresh", clientId: "client" });
      return gate.promise;
    });
    const credentials = { access: "expired", refresh: "single-flight-refresh", expires: 0, region: "eu-west-2", authMethod: "idc", clientId: "client", clientSecret: "secret", profileArn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/a" };
    const first = refreshCredentials(credentials);
    const second = refreshCredentials(credentials);
    gate.resolve(Response.json({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 }));
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.refresh).toBe("rotated");
    expect(a.profileArn).toBe(credentials.profileArn);
    expect(await refreshCredentials(credentials)).toBe(a);
    expect(calls).toBe(1);
  });
  test("failed refresh clears the in-flight entry and never exposes response tokens", async () => {
    let calls = 0;
    mockFetch(() => ++calls === 1 ? new Response("secret-body", { status: 401 }) : Response.json({ accessToken: "retry-access", expiresIn: 3600 }));
    const credentials = { access: "expired", refresh: "retry-refresh", region: "us-east-1", authMethod: "desktop" };
    await expect(refreshCredentials(credentials)).rejects.toThrow("HTTP 401");
    expect((await refreshCredentials(credentials)).access).toBe("retry-access");
    expect(calls).toBe(2);
  });
  test("external IdP refresh uses form encoding without an invented client secret", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("https://idp.example.test/oauth/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("external-refresh");
      expect(body.has("client_secret")).toBe(false);
      return Response.json({ access_token: "external-access", refresh_token: "external-rotated", expires_in: 600 });
    });
    const result = await refreshCredentials({ access: "old", refresh: "external-refresh", region: "us-east-1", authMethod: "external-idp", clientId: "public-client", tokenEndpoint: "https://idp.example.test/oauth/token" });
    expect(result.refresh).toBe("external-rotated");
    expect(result.authMethod).toBe("external-idp");
  });
  test("API keys never refresh and GetProfile is pinned to issuing region", async () => {
    delete process.env.KIRO_PROFILE_ARN;
    let calls = 0;
    mockFetch((url, init) => {
      calls++;
      expect(url).toBe("https://management.us-east-1.kiro.dev/");
      expect(new Headers(init?.headers).get("tokentype")).toBe("API_KEY");
      expect(new Headers(init?.headers).get("X-Amz-Target")).toBe("AmazonCodeWhispererService.GetProfile");
      return Response.json({ profile: { arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/api-key" } });
    });
    const credentials = { access: "ksk_test-profile", region: "eu-central-1" };
    expect(await refreshCredentials(credentials)).toBe(credentials);
    const [a, b] = await Promise.all([resolveProfile(credentials), resolveProfile(credentials)]);
    expect(a).toEqual(b);
    expect(a.region).toBe("us-east-1");
    expect(calls).toBe(1);
  });
  test("profile discovery probes regional empty/403 responses and follows ARN region", async () => {
    delete process.env.KIRO_PROFILE_ARN;
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return url.includes("eu-central-1") ? new Response("", { status: 403 }) : Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/cross-region" }] });
    });
    const result = await resolveProfile({ access: "cross-region-token", region: "eu-west-2" });
    expect(result.region).toBe("us-east-1");
    expect(urls).toHaveLength(2);
  });
  test("explicit profile skips discovery and expired cache parses refresh registration", async () => {
    mockFetch(() => { throw new Error("must not request"); });
    const credentials = credentialsFromLocal({ access_token: "saved", refresh_token: "saved-refresh", expires_at: "2020-01-01T00:00:00Z", region: "eu-west-2", profile_arn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/saved" }, { client_id: "client", client_secret: "secret" }, "idc")!;
    expect(credentials.expires).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(credentials.clientSecret).toBe("secret");
    expect((await resolveProfile(credentials)).region).toBe("eu-central-1");
    expect(credentialsFromLocal({})).toBeUndefined();
  });
  test("native OAuth round trip preserves real refresh and registration metadata", () => {
    const credentials = { access: "access", refresh: "real-refresh", expires: 1234567890, region: "eu-west-2", profileArn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/host", authMethod: "external-idp", clientId: "client", tokenEndpoint: "https://idp.example.test/token" };
    const host = toHostCredential(credentials, "reuse-external-idp");
    expect(host.refresh).toBe("real-refresh");
    expect(host.methodID).toBe("reuse-external-idp");
    expect(fromHostCredential(host)).toEqual({ ...credentials, clientSecret: undefined });
    expect(() => toHostCredential({ access: "ksk_example", region: "us-east-1" }, "reuse-cli")).toThrow("API key");
  });
  test("device flow registers proper scopes, surfaces real code and stores refresh", async () => {
    let tokenCalls = 0;
    mockFetch((url, init) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("client/register")) {
        expect(body.scopes).toContain("codewhisperer:conversations");
        return Response.json({ clientId: "device-client", clientSecret: "device-secret" });
      }
      if (url.endsWith("device_authorization")) return Response.json({ deviceCode: "device", userCode: "USER-CODE", verificationUriComplete: "https://device.example.test/verify", expiresIn: 60, interval: 0.001 });
      tokenCalls++;
      if (tokenCalls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ accessToken: "device-access", refreshToken: "device-refresh", expiresIn: 3600 });
    });
    const authorization = await deviceAuthorization("https://view.awsapps.com/start", "us-east-1");
    expect(authorization.url).toBe("https://device.example.test/verify");
    expect(authorization.instructions).toContain("USER-CODE");
    const result = await authorization.callback;
    expect(result.refresh).toBe("device-refresh");
    expect(result.clientSecret).toBe("device-secret");
    expect(tokenCalls).toBe(2);
  });
});
