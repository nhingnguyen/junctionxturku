import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDef } from "./llm/types.js";

function buildChildEnvironment(keys: string[]): Record<string, string> {
    const env = getDefaultEnvironment();

    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }

    return env;
}

export class McpHub {
    private toolToClient = new Map<string, Client>();
    private clients: Client[] = [];

    /** Khởi động một MCP server và đăng ký các tool của nó */
    async connect(
        command: string,
        args: string[],
        envKeys: string[] = []
    ): Promise<ToolDef[]> {
        const client = new Client({ name: "ai-assistant", version: "1.0.0" });
        await client.connect(
            new StdioClientTransport({
                command,
                args,
                env: buildChildEnvironment(envKeys),
                stderr: "inherit",
            }));
        this.clients.push(client);

        const { tools } = await client.listTools();
        tools.forEach((t) => this.toolToClient.set(t.name, client));

        return tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
        }));
    }

    async call(name: string, args: Record<string, unknown>): Promise<string> {
        const client = this.toolToClient.get(name);
        if (!client) throw new Error(`Unknown tool: ${name}`);

        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");

        return res.isError ? `Error: ${text}` : text;
    }

    async close() {
        await Promise.all(this.clients.map((c) => c.close()));
    }
}
