import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const BUFFER = 120_000;
const refreshing = new Map();
const refreshed = new Map();
const profiles = new Map();
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const SCOPES = ["completions", "analysis", "conversations", "transformations", "taskassist"].map((scope) => `codewhisperer:${scope}`);
export function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function regionName(value) {
    const region = text(value) ?? "us-east-1";
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))
        throw new Error("Invalid Kiro AWS region");
    return region;
}
export function apiRegion(region) {
    return region.startsWith("eu-") ? "eu-central-1" : "us-east-1";
}
function profileRegion(arn, fallback) {
    const region = arn.split(":")[3];
    return region && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : apiRegion(fallback);
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function unexpired(credentials) {
    return credentials.expires === undefined || credentials.expires > Date.now() + BUFFER;
}
export function authHeaders(credentials) {
    const headers = { Authorization: `Bearer ${credentials.access}` };
    if (credentials.access.startsWith("ksk_"))
        headers.tokentype = "API_KEY";
    else {
        let external = credentials.authMethod === "external-idp";
        if (!external) {
            try {
                const segments = credentials.access.split(".");
                external = segments.length === 3 && JSON.parse(Buffer.from(segments[1], "base64url").toString()).aud === "api://kiro";
            }
            catch { /* Opaque SSO and desktop tokens are not JWTs. */ }
        }
        if (external)
            headers.tokentype = "EXTERNAL_IDP";
    }
    return headers;
}
async function jsonResponse(response, operation) {
    if (!response.ok)
        throw new Error(`Kiro ${operation} failed (HTTP ${response.status})`);
    return record(await response.json());
}
function checkedEndpoint(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Kiro token endpoint must use HTTPS without embedded credentials");
    return url.href;
}
export async function refreshCredentials(credentials) {
    if (credentials.access.startsWith("ksk_") || credentials.authMethod === "apikey")
        return credentials;
    if (!credentials.refresh)
        throw new Error("Kiro session expired; reconnect Kiro to sign in again");
    const key = digest(JSON.stringify([credentials.refresh, credentials.region, credentials.authMethod, credentials.clientId, credentials.clientSecret, credentials.tokenEndpoint, credentials.profileArn]));
    const prior = refreshed.get(key);
    if (prior && unexpired(prior))
        return prior;
    const active = refreshing.get(key);
    if (active)
        return active;
    const promise = (async () => {
        const method = credentials.authMethod ?? "idc";
        let url;
        let body;
        let contentType = "application/json";
        if (method === "desktop") {
            url = `https://prod.${regionName(credentials.region)}.auth.desktop.kiro.dev/refreshToken`;
            body = JSON.stringify({ refreshToken: credentials.refresh });
        }
        else if (method === "external-idp") {
            if (!credentials.tokenEndpoint || !credentials.clientId)
                throw new Error("Kiro external IdP session is missing its token endpoint or client ID");
            url = checkedEndpoint(credentials.tokenEndpoint);
            contentType = "application/x-www-form-urlencoded";
            body = new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.clientId, refresh_token: credentials.refresh }).toString();
        }
        else {
            if (!credentials.clientId || !credentials.clientSecret)
                throw new Error("Kiro SSO session is missing its client registration; reconnect Kiro");
            url = `https://oidc.${regionName(credentials.region)}.amazonaws.com/token`;
            body = JSON.stringify({ grantType: "refresh_token", clientId: credentials.clientId, clientSecret: credentials.clientSecret, refreshToken: credentials.refresh });
        }
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json" }, body, signal: AbortSignal.timeout(15_000) });
        const data = await jsonResponse(response, "token refresh");
        const access = text(data.accessToken ?? data.access_token);
        const expiresIn = data.expiresIn ?? data.expires_in;
        if (!access || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
            throw new Error("Kiro token refresh returned an invalid token or lifetime");
        const result = {
            ...credentials, access, refresh: text(data.refreshToken ?? data.refresh_token) ?? credentials.refresh,
            expires: Date.now() + expiresIn * 1000,
            profileArn: text(data.profileArn ?? data.profile_arn) ?? credentials.profileArn,
        };
        refreshed.set(key, result);
        return result;
    })();
    refreshing.set(key, promise);
    try {
        return await promise;
    }
    finally {
        if (refreshing.get(key) === promise)
            refreshing.delete(key);
    }
}
function overrides(credentials, settings) {
    return { ...credentials, region: text(settings.region) ? regionName(settings.region) : credentials.region, profileArn: text(settings.profileArn) ?? text(process.env.KIRO_PROFILE_ARN) ?? credentials.profileArn };
}
export async function resolveCredentials(settings) {
    const key = text(settings.apiKey) ?? text(process.env.KIRO_API_KEY);
    if (key) {
        const credentials = overrides({ access: key, region: regionName(settings.region ?? process.env.KIRO_REGION), authMethod: key.startsWith("ksk_") ? "apikey" : text(settings.authMethod),
            refresh: text(settings.refresh), expires: typeof settings.expires === "number" ? settings.expires : undefined,
            clientId: text(settings.clientId), clientSecret: text(settings.clientSecret), tokenEndpoint: text(settings.tokenEndpoint) }, settings);
        return unexpired(credentials) ? credentials : refreshCredentials(credentials);
    }
    if (settings.reuseCredentials === true || settings.credentialSource === "cli" || settings.credentialSource === "ide") {
        return overrides(await readLocalCredentials(settings.credentialSource === "ide" ? "ide" : settings.credentialSource === "cli" ? "cli" : "auto"), settings);
    }
    throw new Error("Kiro is not connected. Connect an API key, import a CLI/IDE session, or sign in through OpenCode's Kiro integration");
}
export function credentialsFromLocal(token, registration = {}, method) {
    const access = text(token.accessToken ?? token.access_token);
    if (!access)
        return undefined;
    const expiry = token.expiresAt ?? token.expires_at;
    const parsedExpiry = typeof expiry === "number" ? (expiry < 10_000_000_000 ? expiry * 1000 : expiry) : typeof expiry === "string" ? Date.parse(expiry) : NaN;
    const family = String(token.authMethod ?? token.provider ?? "");
    const authMethod = method ?? (/external[-_ ]?idp/i.test(family) ? "external-idp" : /social|desktop|google|github/i.test(family) ? "desktop" : "idc");
    const issuer = text(token.issuer_url);
    return {
        access, refresh: text(token.refreshToken ?? token.refresh_token), expires: Number.isFinite(parsedExpiry) ? parsedExpiry : 0,
        region: regionName(token.region), profileArn: text(token.profileArn ?? token.profile_arn), authMethod,
        clientId: text(token.clientId ?? token.client_id ?? registration.clientId ?? registration.client_id),
        clientSecret: text(token.clientSecret ?? token.client_secret ?? registration.clientSecret ?? registration.client_secret),
        tokenEndpoint: text(token.tokenEndpoint ?? token.token_endpoint) ?? (issuer ? `${issuer.replace(/\/+$/, "")}/v1/token` : undefined),
    };
}
async function readJSON(path) {
    try {
        return record(JSON.parse(await readFile(path, "utf8")));
    }
    catch {
        return undefined;
    }
}
async function ideCredentials() {
    const cache = join(homedir(), ".aws", "sso", "cache");
    const token = await readJSON(join(cache, "kiro-auth-token.json"));
    if (!token)
        return undefined;
    const hash = text(token.clientIdHash);
    const registration = hash && /^[\w-]+$/.test(hash) ? await readJSON(join(cache, `${hash}.json`)) : undefined;
    return credentialsFromLocal(token, registration);
}
function cliPath() {
    if (process.platform === "darwin")
        return join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
    if (process.platform === "win32")
        return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "kiro-cli", "data.sqlite3");
}
async function cliCredentials(method) {
    const sql = "SELECT key,value FROM auth_kv WHERE key IN ('kirocli:odic:token','kirocli:social:token','kirocli:external-idp:token','kirocli:odic:device-registration','codewhisperer:odic:token','codewhisperer:odic:device-registration')";
    let rows;
    if (typeof Bun !== "undefined") {
        try {
            // Bun's platform module cannot be statically imported by the supported Node fallback.
            const { Database } = await import("bun:sqlite");
            const db = new Database(cliPath(), { readonly: true, create: false });
            try {
                rows = db.query(sql).all();
            }
            finally {
                db.close();
            }
        }
        catch { /* A missing or unreadable CLI database falls back to the read-only SQLite command. */ }
    }
    if (!rows) {
        const query = Promise.withResolvers();
        execFile("sqlite3", ["-readonly", "-json", cliPath(), sql], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            try {
                query.resolve(error ? [] : JSON.parse(stdout));
            }
            catch {
                query.resolve([]);
            }
        });
        rows = await query.promise;
    }
    const values = new Map();
    for (const row of rows) {
        try {
            values.set(row.key, record(JSON.parse(row.value)));
        }
        catch { /* Skip malformed cache entries. */ }
    }
    const result = [];
    for (const [key, family] of [["kirocli:social:token", "desktop"], ["kirocli:odic:token", "idc"], ["kirocli:external-idp:token", "external-idp"], ["codewhisperer:odic:token", "idc"]]) {
        if (method && method !== family)
            continue;
        const token = values.get(key);
        if (!token)
            continue;
        const credentials = credentialsFromLocal(token, values.get(`${key.split(":")[0]}:odic:device-registration`), family);
        if (credentials)
            result.push(credentials);
    }
    return result;
}
export async function readLocalCredentials(source = "auto", method) {
    const candidates = source === "ide" ? [await ideCredentials()] : source === "cli" ? await cliCredentials(method) : [await ideCredentials(), ...await cliCredentials(method)];
    const present = candidates.filter((value) => !!value && (!method || value.authMethod === method));
    const fresh = present.find(unexpired);
    if (fresh)
        return fresh;
    let failure;
    for (const credentials of present) {
        try {
            return await refreshCredentials(credentials);
        }
        catch (error) {
            failure = error;
        }
    }
    throw new Error("No usable saved Kiro session. Sign in with kiro-cli or the Kiro IDE, then import it again", failure ? { cause: failure } : undefined);
}
export async function resolveProfile(credentials) {
    const supplied = credentials.profileArn ?? text(process.env.KIRO_PROFILE_ARN);
    if (supplied)
        return { profileArn: supplied, region: profileRegion(supplied, credentials.region) };
    const key = digest(`${credentials.region}:${credentials.access}`);
    const cached = profiles.get(key);
    if (cached)
        return cached;
    const pending = (async () => {
        if (credentials.access.startsWith("ksk_")) {
            const response = await fetch("https://management.us-east-1.kiro.dev/", { method: "POST", headers: { ...authHeaders(credentials), "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetProfile" }, body: "{}", signal: AbortSignal.timeout(15_000) });
            const data = await jsonResponse(response, "GetProfile");
            const profileArn = text(record(data.profile).arn);
            if (!profileArn)
                throw new Error("Kiro GetProfile returned no profile");
            return { profileArn, region: profileRegion(profileArn, "us-east-1") };
        }
        const candidates = [...new Set([apiRegion(credentials.region), "us-east-1", "eu-central-1"])];
        for (const region of candidates) {
            const response = await fetch(`https://management.${region}.kiro.dev/List-Available-Profiles`, { method: "POST", headers: { ...authHeaders(credentials), "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
            if (response.status === 403)
                continue;
            const data = await jsonResponse(response, "ListAvailableProfiles");
            const list = Array.isArray(data.profiles) ? data.profiles : [];
            const profileArn = list.map((profile) => text(record(profile).arn)).find(Boolean);
            if (profileArn)
                return { profileArn, region: profileRegion(profileArn, region) };
        }
        throw new Error("Kiro returned no profile in its management regions; set profileArn to select your account's profile");
    })();
    profiles.set(key, pending);
    try {
        return await pending;
    }
    catch (error) {
        if (profiles.get(key) === pending)
            profiles.delete(key);
        throw error;
    }
}
export async function deviceAuthorization(startUrl, region) {
    const parsed = new URL(startUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        throw new Error("Identity Center start URL must use HTTPS");
    const endpoint = `https://oidc.${regionName(region)}.amazonaws.com`;
    const post = (path, body) => fetch(`${endpoint}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const registration = await jsonResponse(await post("client/register", { clientName: "Kiro CLI", clientType: "public", scopes: SCOPES, grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] }), "client registration");
    const clientId = text(registration.clientId), clientSecret = text(registration.clientSecret);
    if (!clientId || !clientSecret)
        throw new Error("Kiro client registration returned incomplete credentials");
    const authorization = await jsonResponse(await post("device_authorization", { clientId, clientSecret, startUrl }), "device authorization");
    const deviceCode = text(authorization.deviceCode), url = text(authorization.verificationUriComplete ?? authorization.verificationUri), userCode = text(authorization.userCode);
    if (!deviceCode || !url || !userCode || typeof authorization.expiresIn !== "number" || authorization.expiresIn <= 0)
        throw new Error("Kiro returned incomplete device authorization");
    const expiresAt = Date.now() + authorization.expiresIn * 1000;
    const callback = (async () => {
        let interval = typeof authorization.interval === "number" && authorization.interval > 0 ? authorization.interval * 1000 : 5000;
        while (Date.now() < expiresAt) {
            const delay = Promise.withResolvers();
            setTimeout(delay.resolve, Math.min(interval, Math.max(0, expiresAt - Date.now())));
            await delay.promise;
            if (Date.now() >= expiresAt)
                break;
            const response = await post("token", { grantType: "urn:ietf:params:oauth:grant-type:device_code", deviceCode, clientId, clientSecret });
            const data = record(await response.json());
            const error = text(data.error ?? data.__type)?.split("#").at(-1);
            if (error === "authorization_pending" || error === "AuthorizationPendingException")
                continue;
            if (error === "slow_down" || error === "SlowDownException") {
                interval += 5000;
                continue;
            }
            const access = text(data.accessToken), refresh = text(data.refreshToken);
            if (!response.ok || error || !access || !refresh || typeof data.expiresIn !== "number" || data.expiresIn <= 0)
                throw new Error(`Kiro device login failed (HTTP ${response.status})`);
            return { access, refresh, expires: Date.now() + data.expiresIn * 1000, region, authMethod: "idc", clientId, clientSecret };
        }
        throw new Error("Kiro device authorization expired; start sign-in again");
    })();
    // The host attaches its callback after this function returns; avoid an early unhandled rejection.
    void callback.catch(() => { });
    return { url, instructions: `Enter code ${userCode} and approve Kiro access in your browser.`, expiresAt, callback };
}
export async function cliAuthorization(provider) {
    const child = spawn("kiro-cli", ["login", "--license", "free"], { stdio: ["inherit", "pipe", "pipe"] });
    const expiresAt = Date.now() + 120_000;
    let output = "";
    const urlReady = Promise.withResolvers();
    const timer = setTimeout(() => child.kill(), 120_000);
    const capture = (chunk) => {
        output = (output + chunk.toString()).slice(-16_384);
        const url = output.replace(/\x1b\[[0-9;]*m/g, "").match(/https:\/\/(?:app\.kiro\.dev|[^\s/]+\.awsapps\.com)\/[^\s<>"']+/)?.[0];
        if (url)
            urlReady.resolve(url);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const completion = Promise.withResolvers();
    child.on("error", () => { clearTimeout(timer); const error = new Error("Cannot start kiro-cli; install it and ensure it is on PATH"); urlReady.reject(error); completion.reject(error); });
    child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
            const error = new Error("kiro-cli login failed or timed out");
            urlReady.reject(error);
            completion.reject(error);
            return;
        }
        urlReady.resolve("https://app.kiro.dev/signin");
        readLocalCredentials("cli", "desktop").then(completion.resolve, completion.reject);
    });
    void completion.promise.catch(() => { });
    return { url: await urlReady.promise, instructions: `Select ${provider === "google" ? "Google" : "GitHub"} on Kiro's sign-in page. Authentication is delegated to kiro-cli.`, expiresAt, callback: completion.promise };
}
