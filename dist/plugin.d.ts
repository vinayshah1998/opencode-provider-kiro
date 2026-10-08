import { Credential, Plugin } from "@opencode/plugin";
import { type KiroCredentials } from "./auth.js";
export declare function fromHostCredential(value: Credential.Value): KiroCredentials;
export declare function toHostCredential(credentials: KiroCredentials, methodID: string): Credential.OAuth;
export declare const KiroPlugin: Plugin.Plugin;
export default KiroPlugin;
