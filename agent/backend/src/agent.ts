import type { ChatMessage, LLMProvider, ToolDef } from "./llm/types.js";
import type { McpHub } from "./mcp-client.js";
import { buildSystemPrompt } from "./system-prompt.js";

const MAX_TOOL_STEPS = 5;

export async function runAgent(
    llm: LLMProvider,
    hub: McpHub,
    tools: ToolDef[],
    history: ChatMessage[]
): Promise<string> {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const res = await llm.chat(
            [{ role: "system", content: buildSystemPrompt() }, ...history],
            tools
        );
        console.log("LLM raw:", JSON.stringify({ text: res.text, toolCalls: res.toolCalls }));
        history.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

        // Không gọi tool nữa -> đây là câu trả lời cuối
        if (res.toolCalls.length === 0) return res.text;

        for (const call of res.toolCalls) {
            console.log(`🔧 Tool call: ${call.name}`, call.args);
            const output = await hub
                .call(call.name, call.args)
                .catch((e: Error) => `Error: ${e.message}`);
            console.log(`📦 Result: ${output}`);
            history.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
        }
    }

    // Give the model one tool-free turn to summarize the gathered results even
    // when it used every available tool step.
    const finalResponse = await llm.chat(
        [
            { role: "system", content: buildSystemPrompt() },
            ...history,
            {
                role: "system",
                content:
                    "The tool-call limit has been reached. Answer now using the available tool results. Do not request another tool.",
            },
        ],
        []
    );

    history.push({ role: "assistant", content: finalResponse.text });
    return finalResponse.text || "Unable to produce a final answer from the available tool results.";
}
