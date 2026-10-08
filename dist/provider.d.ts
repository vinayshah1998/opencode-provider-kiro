import { type ProviderPackageSettings } from "@opencode/ai";
export interface KiroSettings extends ProviderPackageSettings {
    readonly apiKey?: string;
    readonly region?: string;
    readonly profileArn?: string;
}
/** OpenCode 2.0.23 native provider-package entrypoint. No nested CLI agent. */
export declare function model(modelID: string, settings?: KiroSettings): import("@opencode/ai").LanguageModel<{
    readonly [x: string]: unknown;
}, import("@opencode/ai/route").CompactionOperations | undefined>;
