import { type LLMRequest } from "@opencode/ai";
type Image = {
    format: string;
    source: {
        bytes: string;
    };
};
type ToolUse = {
    name: string;
    toolUseId: string;
    input: Record<string, unknown>;
};
type ToolResult = {
    toolUseId: string;
    status: "success" | "error";
    content: {
        text: string;
    }[];
};
type ToolSpec = {
    toolSpecification: {
        name: string;
        description: string;
        inputSchema: {
            json: Record<string, unknown>;
        };
    };
};
type UserInput = {
    content: string;
    modelId: string;
    origin: "KIRO_CLI";
    images?: Image[];
    userInputMessageContext?: {
        toolResults?: ToolResult[];
        tools?: ToolSpec[];
    };
};
type AssistantResponse = {
    content: string;
    toolUses?: ToolUse[];
};
export type KiroHistoryEntry = {
    userInputMessage: UserInput;
} | {
    assistantResponseMessage: AssistantResponse;
};
export type KiroConversation = {
    conversationState: {
        conversationId: string;
        chatTriggerType: "MANUAL";
        agentTaskType: "vibe";
        currentMessage: {
            userInputMessage: UserInput;
        };
        history?: KiroHistoryEntry[];
    };
    additionalModelRequestFields?: Record<string, unknown>;
};
/** Keep Kiro IDs unchanged and consistently remap other providers' opaque IDs. */
export declare function toKiroToolUseId(id: string): string;
export declare function buildConversation(request: LLMRequest): Promise<Record<string, unknown>>;
export {};
