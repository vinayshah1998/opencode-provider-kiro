import { Schema } from "effect";
import { AIError, LLMEvent, Usage, type FinishReasonDetails } from "@opencode/ai";
import { Lifecycle } from "@opencode/ai/protocols/utils/lifecycle";
import type { Framing } from "@opencode/ai/route";
export declare function outputError(message: string, incomplete?: boolean): AIError;
export declare const WireEvent: Schema.Struct<{
    readonly kind: Schema.String;
    readonly type: Schema.String;
    readonly data: Schema.$Record<Schema.String, Schema.Unknown>;
}>;
export type WireEvent = typeof WireEvent.Type;
/** Retains only the unfinished frame; growth is amortized, bounded before allocation. */
export declare class FrameDecoder {
    private buffer;
    private length;
    push(bytes: Uint8Array): WireEvent[];
    private frameLength;
    finish(): void;
}
export declare const framing: Framing.Definition<WireEvent>;
/** Native exception names and their modeled union aliases are both used on the wire. */
export declare function providerError(type: string, data: Record<string, unknown>, status?: number): AIError;
type ToolState = {
    id: string;
    name: string;
    input: string;
};
export interface ParserState {
    lifecycle: Lifecycle.State;
    activeTool?: ToolState;
    toolIDs: Set<string>;
    hasContent: boolean;
    hasTools: boolean;
    reason?: FinishReasonDetails;
    usage?: Usage;
    metadata: Record<string, unknown>;
    signature?: string;
    block: number;
    channel?: "text" | "reasoning";
    tagged: boolean;
    pendingText: string;
    closingTag?: string;
}
export declare function initial(tagged?: boolean): ParserState;
export declare function step(state: ParserState, event: WireEvent): readonly [ParserState, LLMEvent[]];
export declare function finish(state: ParserState): LLMEvent[];
export {};
