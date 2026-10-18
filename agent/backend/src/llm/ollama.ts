import { Ollama } from "ollama";
import { randomUUID } from "node:crypto";
import type { ChatMessage, LLMProvider, LLMResponse, ToolDef } from "./types.js";

export class OllamaProvider implements LLMProvider {
    private client: Ollama;

    constructor(
        host = process.env.OLLAMA_URL ?? "http://localhost:11434",
        private model = process.env.OLLAMA_MODEL ?? "gemma4:31b-cloud"
    ) {
        this.client = new Ollama({
            host,
            headers: process.env.OLLAMA_API_KEY
                ? {
                      Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                  }
                : undefined,
        });
    }

    async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMResponse> {
        const res = await this.client.chat({
            model: this.model,
            stream: false,
            messages: messages.map((m) => {
                if (m.role === "tool") {
                    return { role: "tool", content: m.content, tool_name: m.name };
                }
                return {
                    role: m.role,
                    content: m.content,
                    ...(m.toolCalls?.length && {
                        tool_calls: m.toolCalls.map((c) => ({
                            function: { name: c.name, arguments: c.args },
                        })),
                    }),
                };
            }),
            // Dịch định dạng MCP -> định dạng tool của Ollama
            tools: tools.map((t) => ({
                type: "function",
                function: {
                    name: t.name,
                    description: t.description ?? "",
                    parameters: t.inputSchema,
                },
            })) as any,
        });

        return {
            text: res.message.content ?? "",
            toolCalls: (res.message.tool_calls ?? []).map((c) => ({
                id: randomUUID(), // Ollama không luôn trả id nên tự tạo
                name: c.function.name,
                args: c.function.arguments as Record<string, unknown>,
            })),
        };
    }
}
