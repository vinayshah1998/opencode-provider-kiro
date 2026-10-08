export interface KiroCredentials {
    access: string;
    refresh?: string;
    expires?: number;
    region: string;
    profileArn?: string;
    authMethod?: string;
    clientId?: string;
    clientSecret?: string;
    tokenEndpoint?: string;
}
export declare const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export declare function text(value: unknown): string | undefined;
export declare function apiRegion(region: string): string;
export declare function authHeaders(credentials: KiroCredentials): Record<string, string>;
export declare function refreshCredentials(credentials: KiroCredentials): Promise<KiroCredentials>;
export declare function resolveCredentials(settings: Readonly<Record<string, unknown>>): Promise<KiroCredentials>;
export declare function credentialsFromLocal(token: Record<string, unknown>, registration?: Record<string, unknown>, method?: string): KiroCredentials | undefined;
export declare function readLocalCredentials(source?: "cli" | "ide" | "auto", method?: string): Promise<KiroCredentials>;
export declare function resolveProfile(credentials: KiroCredentials): Promise<{
    profileArn: string;
    region: string;
}>;
export interface Authorization {
    url: string;
    instructions: string;
    expiresAt: number;
    callback: Promise<KiroCredentials>;
}
export declare function deviceAuthorization(startUrl: string, region: string): Promise<Authorization>;
export declare function cliAuthorization(provider: "google" | "github"): Promise<Authorization>;
