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
    {
        name: "property-articles",
        command: "npx",
        args: [
            "tsx",
            process.env.MCP_ARTICLES_PATH ?? "../mcp-articles/src/index.ts",
        ],
        envKeys: [
            "ARTICLE_SEARCH_PROVIDER",
            "BRAVE_SEARCH_API_KEY",
            "BRAVE_SEARCH_BASE_URL",
            "GDELT_DOC_API_URL",
        ],
    },
    {
        name: "property-risk",
        command: "npx",
        args: [
            "tsx",
            process.env.MCP_RISK_PATH ?? "../mcp-risk/src/index.ts",
        ],
        envKeys: [
            "TIMEZONE",
            "RISK_DATA_PATH",
            "HSY_WATER_MAPSERVER_URL",
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
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SESSIONS = 500;
const MAX_USER_TURNS_PER_SESSION = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function getSession(requestedSessionId: unknown): {
    sessionId: string;
    history: ChatMessage[];
} {
    const sessionId =
        typeof requestedSessionId === "string" && UUID_PATTERN.test(requestedSessionId)
            ? requestedSessionId
            : randomUUID();
    const existing = sessions.get(sessionId);

    if (existing) {
        sessions.delete(sessionId);
        sessions.set(sessionId, existing);
        return { sessionId, history: existing };
    }

    while (sessions.size >= MAX_SESSIONS) {
        const oldestSessionId = sessions.keys().next().value;
        if (typeof oldestSessionId !== "string") break;
        sessions.delete(oldestSessionId);
    }

    const history: ChatMessage[] = [];
    sessions.set(sessionId, history);
    return { sessionId, history };
}

function retainRecentTurns(history: ChatMessage[]): void {
    const userMessageIndexes = history.flatMap((message, index) =>
        message.role === "user" ? [index] : []
    );
    if (userMessageIndexes.length <= MAX_USER_TURNS_PER_SESSION) return;

    const firstRetainedIndex =
        userMessageIndexes[userMessageIndexes.length - MAX_USER_TURNS_PER_SESSION];
    if (firstRetainedIndex > 0) history.splice(0, firstRetainedIndex);
}

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
});
const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(cors(corsOrigin ? { origin: corsOrigin } : {}));
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => {
    res.json({ status: "ok", provider: process.env.LLM_PROVIDER ?? "ollama" });
});

app.get("/tools", (_req, res) => {
    res.json(tools.map((t) => ({ name: t.name, description: t.description })));
});

app.post("/chat", async (req, res) => {
    const { message, sessionId: requestedSessionId } = req.body ?? {};
    if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "`message` is required" });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
            error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
        });
    }

    const { sessionId, history } = getSession(requestedSessionId);
    retainRecentTurns(history);
    history.push({ role: "user", content: message });

    try {
        const reply = await runAgent(llm, hub, tools, history);
        retainRecentTurns(history);
        res.setHeader("Cache-Control", "no-store");
        res.json({ sessionId, reply });
    } catch (e) {
        console.error(
            "Chat request failed:",
            e instanceof Error ? `${e.name}: ${e.message}` : "Unknown error"
        );
        res.status(500).json({
            error: "Không thể hoàn tất yêu cầu lúc này. Vui lòng thử lại.",
        });
    }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`🚀 API listening on http://localhost:${port}`));

process.on("SIGINT", async () => {
    await hub.close();
    process.exit(0);
});
