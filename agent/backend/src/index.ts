import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { createProvider } from "./llm/index.js";
import { McpHub } from "./mcp-client.js";
import { runAgent } from "./agent.js";
import type { ChatMessage, ToolDef } from "./llm/types.js";

// const MCP_SERVERS = [
//     { name: "weather", command: "npx", args: ["tsx", process.env.MCP_WEATHER_PATH ?? "../mcp-weather/src/index.ts"] },
//     { name: "calendar", command: "npx", args: ["tsx", process.env.MCP_CALENDAR_PATH ?? "../mcp-calendar/src/index.ts"] },
//     { name: "hackernews", command: "npx", args: ["tsx", process.env.MCP_NEWS_PATH ?? "../mcp-hackernews/src/index.ts"] },
//     { name: "github", command: "npx", args: ["tsx", process.env.MCP_GITHUB_PATH ?? "../mcp-github/src/index.ts"] },
// ];
interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
    envKeys: string[];
}

const MCP_SERVERS: McpServerConfig[] = [
    {
        name: "ryhti",
        command: "npx",
        args: ["tsx", process.env.MCP_RYHTI_PATH ?? "../mcp-ryhti/src/index.ts"],
        envKeys: ["TIMEZONE", "SYKE_USER_ID"],
    },
    {
        name: "mml",
        command: "npx",
        args: ["tsx", process.env.MCP_MML_PATH ?? "../mcp-mml/src/index.ts"],
        envKeys: [
            "TIMEZONE",
            "MML_API_KEY",
            "MML_BASE_URL",
            "MML_GEOCODING_BASE_URL",
        ],
    },
    {
        name: "helsinki-decisions",
        command: "npx",
        args: [
            "tsx",
            process.env.MCP_HELSINKI_DECISIONS_PATH ??
                "../mcp-helsinki-decisions/src/index.ts",
        ],
        envKeys: [
            "TIMEZONE",
            "HELSINKI_DECISIONS_API_URL",
            "PARCEL_DATA_PATH",
        ],
    },
];

const llm = createProvider();
const hub = new McpHub();
const tools: ToolDef[] = [];

for (const s of MCP_SERVERS) {
    const t = await hub.connect(s.command, s.args, s.envKeys);
    console.log(`✅ ${s.name}:`, t.map((x) => x.name));
    tools.push(...t);
}

// Lịch sử hội thoại theo từng session (lưu trong RAM)
const sessions = new Map<string, ChatMessage[]>();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
    res.json({ status: "ok", provider: process.env.LLM_PROVIDER ?? "ollama" });
});

app.get("/tools", (_req, res) => {
    res.json(tools.map((t) => ({ name: t.name, description: t.description })));
});

app.post("/chat", async (req, res) => {
    const { message, sessionId = randomUUID() } = req.body ?? {};
    if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "`message` is required" });
    }

    const history = sessions.get(sessionId) ?? [];
    history.push({ role: "user", content: message });
    sessions.set(sessionId, history);

    try {
        const reply = await runAgent(llm, hub, tools, history);
        res.json({ sessionId, reply });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: (e as Error).message });
    }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`🚀 API listening on http://localhost:${port}`));

process.on("SIGINT", async () => {
    await hub.close();
    process.exit(0);
});
