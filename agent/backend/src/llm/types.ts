export interface ToolDef {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export type ChatMessage =
    | { role: "user" | "assistant" | "system"; content: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LLMResponse {
    text: string;
    toolCalls: ToolCall[];
}

export interface LLMProvider {
    chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMResponse>;
}