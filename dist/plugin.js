import { Integration, Plugin } from "@opencode/plugin";
import { authHeaders, BUILDER_ID_START_URL, cliAuthorization, deviceAuthorization, readLocalCredentials, refreshCredentials, resolveCredentials, resolveProfile, text } from "./auth.js";
import { availableCatalog, bootstrapModels, PROVIDER_ID, PROVIDER_PACKAGE } from "./catalog.js";
const INTEGRATION_ID = Integration.ID.make("kiro");
export function fromHostCredential(value) {
    if (value.type === "key") {
        const settings = { ...value.metadata, ...value.configuration };
        return { access: value.key, region: text(settings.region) ?? "us-east-1", profileArn: text(settings.profileArn), authMethod: value.key.startsWith("ksk_") ? "apikey" : undefined };
    }
    const metadata = value.metadata ?? {};
    return {
        access: value.access, refresh: value.refresh, expires: value.expires,
        region: text(metadata.region) ?? "us-east-1", profileArn: text(metadata.profileArn), authMethod: text(metadata.authMethod) ?? "idc",
        clientId: text(metadata.clientId), clientSecret: text(metadata.clientSecret), tokenEndpoint: text(metadata.tokenEndpoint),
    };
}
export function toHostCredential(credentials, methodID) {
    if (!credentials.refresh || credentials.expires === undefined)
        throw new Error("This Kiro session cannot be persisted as OAuth; connect it as an API key instead");
    return {
        type: "oauth", methodID: Integration.MethodID.make(methodID), access: credentials.access, refresh: credentials.refresh, expires: Math.trunc(credentials.expires),
        metadata: Object.fromEntries(Object.entries({ region: credentials.region, profileArn: credentials.profileArn, authMethod: credentials.authMethod, clientId: credentials.clientId, clientSecret: credentials.clientSecret, tokenEndpoint: credentials.tokenEndpoint }).filter(([, value]) => value !== undefined)),
    };
}
export const KiroPlugin = Plugin.define({
    id: "opencode-provider-kiro",
    async setup(ctx) {
        const registrations = [];
        let catalog = bootstrapModels();
        let profileSettings = {};
        let sourceConnection;
        let catalogConnection;
        let providerSettings = {};
        let catalogLoading;
        const loadCatalog = async (credentials, connection) => {
            const identity = connection?.type === "credential" ? `credential:${connection.id}` : connection?.type === "env" ? `env:${connection.name}` : "settings";
            const scope = `${identity}:${credentials.region}:${credentials.profileArn ?? ""}`;
            if (catalogConnection === scope)
                return;
            if (catalogLoading) {
                await catalogLoading;
                if (catalogConnection === scope)
                    return;
            }
            catalogLoading = (async () => {
                const result = await availableCatalog(credentials);
                catalog = result.models;
                profileSettings = { region: result.region, ...(result.profileArn ? { profileArn: result.profileArn } : {}) };
                sourceConnection = connection;
                if (!result.offline)
                    catalogConnection = scope;
                await ctx.provider.reload();
            })();
            try {
                await catalogLoading;
            }
            finally {
                catalogLoading = undefined;
            }
        };
        const saveSession = async (credentials, methodID) => {
            const result = await availableCatalog(credentials);
            return toHostCredential({ ...credentials, ...(result.profileArn ? { profileArn: result.profileArn } : {}) }, methodID);
        };
        const refresh = async (credential) => toHostCredential(await refreshCredentials(fromHostCredential(credential)), credential.methodID);
        const authorizeDevice = async (methodID, startUrl, region) => {
            const authorization = await deviceAuthorization(startUrl, region);
            return { ...authorization, mode: "auto", callback: authorization.callback.then((credentials) => saveSession(credentials, methodID)) };
        };
        registrations.push(await ctx.provider.transform((editor) => {
            const existing = editor.get(PROVIDER_ID);
            providerSettings = { ...ctx.options, ...existing?.provider.settings };
            const explicitReuse = providerSettings.reuseCredentials === true || providerSettings.credentialSource === "cli" || providerSettings.credentialSource === "ide";
            editor.add({
                info: {
                    ...existing?.provider, id: PROVIDER_ID, integrationID: INTEGRATION_ID, name: "Kiro", activation: existing?.provider.activation === "disabled" ? "disabled" : explicitReuse ? "enabled" : existing?.provider.activation ?? "auto", package: PROVIDER_PACKAGE,
                    // Only public routing metadata belongs in provider inventory. Secrets stay in host credentials.
                    settings: { ...providerSettings, ...profileSettings },
                },
                models: catalog, ...(sourceConnection ? { sourceConnection } : {}),
            });
        }));
        registrations.push(await ctx.integration.transform((editor) => {
            editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "Kiro API key", form: [
                        { type: "string", key: "region", title: "Kiro region", default: "us-east-1" },
                        { type: "string", key: "profileArn", title: "Profile ARN (optional)" },
                    ] } });
            editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "env", names: ["KIRO_API_KEY"] } });
            editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "oauth", id: "builder-id", label: "AWS Builder ID" },
                authorize: () => authorizeDevice("builder-id", BUILDER_ID_START_URL, "us-east-1"), refresh });
            editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "oauth", id: "identity-center", label: "IAM Identity Center", form: [
                        { type: "string", key: "startUrl", title: "Identity Center start URL", format: "uri", required: true, placeholder: "https://organization.awsapps.com/start" },
                        { type: "string", key: "region", title: "Identity Center region", required: true, default: "us-east-1" },
                    ] }, authorize: (answer) => {
                    const startUrl = text(answer.startUrl), region = text(answer.region);
                    if (!startUrl || !region)
                        throw new Error("Identity Center requires a start URL and its AWS region");
                    return authorizeDevice("identity-center", startUrl, region);
                }, refresh });
            for (const source of ["cli", "ide", "external-idp"]) {
                const label = source === "cli" ? "Reuse Kiro CLI session" : source === "ide" ? "Reuse Kiro IDE session" : "Reuse external IdP session (Kiro CLI)";
                editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "oauth", id: `reuse-${source}`, label },
                    authorize: async () => {
                        const credentials = await readLocalCredentials(source === "ide" ? "ide" : "cli", source === "external-idp" ? "external-idp" : undefined);
                        return { mode: "auto", url: "https://kiro.dev/docs/cli/authentication/", instructions: "Importing your saved Kiro session. No browser sign-in is required.", callback: saveSession(credentials, `reuse-${source}`) };
                    }, refresh });
            }
            for (const provider of ["google", "github"]) {
                editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "oauth", id: provider, label: `${provider === "google" ? "Google" : "GitHub"} (via Kiro CLI)` },
                    authorize: async () => {
                        const authorization = await cliAuthorization(provider);
                        return { ...authorization, mode: "auto", callback: authorization.callback.then((credentials) => saveSession(credentials, provider)) };
                    }, refresh });
            }
        }));
        const connected = async () => {
            const connection = await ctx.integration.connection.active(INTEGRATION_ID);
            if (connection) {
                const value = await ctx.integration.connection.resolve(connection);
                if (!value)
                    throw new Error("Kiro connection has no usable credentials; reconnect Kiro");
                return { credentials: fromHostCredential(value), connection };
            }
            const current = await ctx.provider.get({ providerID: PROVIDER_ID });
            return { credentials: await resolveCredentials(current.data.settings ?? providerSettings) };
        };
        registrations.push(await ctx.session.hook("model.request", async (event) => {
            const { credentials, connection } = await connected();
            const profile = await resolveProfile(credentials);
            event.baseURL = `https://runtime.${profile.region}.kiro.dev/`;
            delete event.headers.tokentype;
            Object.assign(event.headers, authHeaders(credentials));
            await loadCatalog({ ...credentials, profileArn: profile.profileArn }, connection);
        }, { providerID: PROVIDER_ID }));
        registrations.push(await ctx.session.hook("http.request", async (event) => {
            const { credentials } = await connected();
            const profile = await resolveProfile(credentials);
            const url = new URL(event.request.url);
            if (!/^runtime\.[a-z0-9-]+\.kiro\.dev$/.test(url.hostname))
                throw new Error("Refusing to send Kiro credentials to an unrecognized runtime host");
            url.hostname = `runtime.${profile.region}.kiro.dev`;
            const headers = new Headers(event.request.headers);
            headers.delete("tokentype");
            for (const [name, value] of Object.entries(authHeaders(credentials)))
                headers.set(name, value);
            const body = await event.request.clone().json();
            body.profileArn = profile.profileArn;
            headers.delete("content-length");
            event.request = new Request(url, { method: event.request.method, headers, body: JSON.stringify(body), signal: event.request.signal });
        }, { providerID: PROVIDER_ID }));
        // Startup only inspects the selected host connection, never local caches or login flows.
        // The native host refresh callback owns OAuth persistence when resolve() refreshes a grant.
        try {
            const current = await ctx.provider.get({ providerID: PROVIDER_ID });
            const startupSettings = { ...ctx.options, ...providerSettings, ...current.data.settings };
            const connection = await ctx.integration.connection.active(INTEGRATION_ID);
            if (connection) {
                const value = await ctx.integration.connection.resolve(connection);
                if (value)
                    await loadCatalog(fromHostCredential(value), connection);
            }
            else if (text(startupSettings.apiKey) || text(process.env.KIRO_API_KEY) || startupSettings.reuseCredentials === true || startupSettings.credentialSource === "cli" || startupSettings.credentialSource === "ide") {
                await loadCatalog(await resolveCredentials(startupSettings));
            }
        }
        catch (error) {
            console.warn(`[opencode-provider-kiro] Catalog startup unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        return async () => {
            for (const registration of registrations.reverse())
                await registration.dispose();
        };
    },
});
export default KiroPlugin;
