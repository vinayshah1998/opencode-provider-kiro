import { Model } from "@opencode/plugin";
import { type KiroCredentials } from "./auth.js";
export declare const PROVIDER_ID: string & import("effect/Brand").Brand<"Provider.ID">;
export declare const PROVIDER_PACKAGE: string;
export interface KiroCatalogModel {
    modelId: string;
    displayName?: string;
    tokenLimits?: {
        maxInputTokens?: number;
        maxOutputTokens?: number;
    };
    additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
    [key: string]: unknown;
}
export interface KiroEffortConfig {
    field: "reasoning" | "output_config";
    values: string[];
    summarizedThinking: boolean;
}
export declare function effortConfig(schema: unknown, modelID: string): KiroEffortConfig | undefined;
export declare function mapCatalogModels(models: readonly KiroCatalogModel[]): Model.Info[];
export declare function bootstrapModels(): Model.Info[];
export declare function discoverCatalog(credentials: KiroCredentials): Promise<{
    models: Model.Info[];
    profileArn: string;
    region: string;
}>;
export declare function availableCatalog(credentials: KiroCredentials): Promise<{
    models: Model.Info[];
    profileArn?: string;
    region: string;
    offline: boolean;
}>;
