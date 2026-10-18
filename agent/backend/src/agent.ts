import type { ChatMessage, LLMProvider, ToolDef } from "./llm/types.js";
import type { McpHub } from "./mcp-client.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
    findEvidenceClaimIssues,
    findPublicReplyIssues,
    publicRewriteGuidance,
    sanitizePublicReply,
} from "./public-output.js";

const DEFAULT_MAX_AGENT_STEPS = 18;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 30;
const MAX_IDENTICAL_TOOL_CALLS = 2;
const MAX_URL_GUARD_REMINDERS = 2;
const MAX_REQUIRED_TOOL_REMINDERS = 2;
const MAX_CITATION_REMINDERS = 2;
const MAX_PRESENTATION_REMINDERS = 4;
const AGENT_DEBUG = process.env.AGENT_DEBUG === "true";

const ARTICLE_SOURCE_DOMAINS = new Set([
    "is.fi",
    "iltalehti.fi",
    "hs.fi",
    "yle.fi",
    "mtvuutiset.fi",
    "ts.fi",
    "helsinginuutiset.fi",
    "poliisi.fi",
    "pelastustoimi.fi",
    "hel.fi",
    "sttinfo.fi",
    "helsinkitimes.fi",
    "dailyfinland.fi",
]);

function canonicalArticleUrl(value: string): string | null {
    try {
        const url = new URL(value.replace(/[.,;:!?]+$/u, ""));
        const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
        const allowed = [...ARTICLE_SOURCE_DOMAINS].some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
        );
        if (!allowed || !["http:", "https:"].includes(url.protocol)) return null;
        for (const key of [...url.searchParams.keys()]) {
            if (key.toLocaleLowerCase("en-US").startsWith("utm_")) {
                url.searchParams.delete(key);
            }
        }
        url.hash = "";
        return url.toString();
    } catch {
        return null;
    }
}

function latestUserText(history: ChatMessage[]): string {
    const message = [...history]
        .reverse()
        .find((item) => item.role === "user");
    return message?.role === "user" ? message.content : "";
}

function articleUrlsInLatestUserMessage(history: ChatMessage[]): string[] {
    const matches = latestUserText(history).match(/https?:\/\/[^\s<>\])}]+/giu) ?? [];
    return [
        ...new Set(
            matches
                .map(canonicalArticleUrl)
                .filter((url): url is string => Boolean(url))
        ),
    ];
}

function decisionUrlsInHistory(history: ChatMessage[]): string[] {
    const urls = history
        .filter(
            (message) =>
                message.role === "tool" &&
                (message.name === "helsinki_search_parcel_decisions" ||
                    message.name === "helsinki_get_decision_context")
        )
        .flatMap(
            (message) =>
                message.content.match(/https:\/\/paatokset\.hel\.fi\/[^\u0000-\u0020"'<>]+/giu) ?? []
        )
        .map((url) => url.replace(/\\u0026/giu, "&").replace(/[.,;:!?]+$/u, ""));
    return [...new Set(urls)];
}

function boundedPositiveInteger(
    value: string | undefined,
    fallback: number,
    maximum: number
): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0
        ? Math.min(parsed, maximum)
        : fallback;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Guard only unconditional instructions. A conditional mention such as
 * "verify every article used with get_property_article_context" must not force
 * a context call when article discovery returned no candidates.
 */
function explicitlyRequiredTools(
    history: ChatMessage[],
    tools: ToolDef[]
): Set<string> {
    const request = latestUserText(history);
    return new Set(
        tools
            .map((tool) => tool.name)
            .filter((name) => {
                const escaped = escapeRegExp(name);
                return new RegExp(
                    `(?:bắt\\s+buộc\\s+gọi|hãy\\s+dùng|hãy\\s+gọi|must\\s+(?:call|use)|always\\s+call)\\s+\\x60?${escaped}\\x60?`,
                    "iu"
                ).test(request);
            })
    );
}

function stableToolSignature(name: string, args: Record<string, unknown>): string {
    const orderedArgs = Object.fromEntries(
        Object.entries(args).sort(([left], [right]) => left.localeCompare(right))
    );
    return `${name}:${JSON.stringify(orderedArgs)}`;
}

export async function runAgent(
    llm: LLMProvider,
    hub: McpHub,
    tools: ToolDef[],
    history: ChatMessage[]
): Promise<string> {
    const maxAgentSteps = boundedPositiveInteger(
        process.env.AGENT_MAX_STEPS,
        DEFAULT_MAX_AGENT_STEPS,
        40
    );
    const maxTotalToolCalls = boundedPositiveInteger(
        process.env.AGENT_MAX_TOOL_CALLS,
        DEFAULT_MAX_TOTAL_TOOL_CALLS,
        80
    );
    const suppliedArticleUrls = articleUrlsInLatestUserMessage(history);
    const verifiedArticleUrls = new Set<string>();
    const requiredTools = explicitlyRequiredTools(history, tools);
    const calledTools = new Set<string>();
    const signatureCounts = new Map<string, number>();
    let totalToolCalls = 0;
    let urlGuardReminders = 0;
    let requiredToolReminders = 0;
    let citationReminders = 0;
    let presentationReminders = 0;

    for (
        let step = 0;
        step < maxAgentSteps && totalToolCalls < maxTotalToolCalls;
        step++
    ) {
        const res = await llm.chat(
            [{ role: "system", content: buildSystemPrompt() }, ...history],
            tools
        );
        if (AGENT_DEBUG) {
            console.log("Agent step:", {
                responseCharacters: res.text.length,
                toolCalls: res.toolCalls.map((call) => call.name),
            });
        }
        history.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

        if (res.toolCalls.length === 0) {
            const unverifiedUrls = suppliedArticleUrls.filter(
                (url) => !verifiedArticleUrls.has(url)
            );
            if (
                unverifiedUrls.length > 0 &&
                urlGuardReminders < MAX_URL_GUARD_REMINDERS
            ) {
                urlGuardReminders += 1;
                history.push({
                    role: "system",
                    content: [
                        "URL verification guard: the user supplied an article URL that has not been read with a tool.",
                        "Before describing its title, event, cause, location, date, paywall status, or relevance, call get_property_article_context.",
                        "Use the property address from the conversation when available; otherwise call the tool with the URL alone.",
                        `URLs requiring verification: ${unverifiedUrls.join(", ")}`,
                        "Do not infer article contents from the URL or from the user's description.",
                    ].join("\n"),
                });
                continue;
            }
            if (unverifiedUrls.length > 0) {
                return "Mình chưa thể đọc và xác minh nội dung URL bài báo này, nên không thể mô tả hoặc kết luận về bài đó một cách đáng tin cậy.";
            }

            const missingRequiredTools = [...requiredTools].filter(
                (name) => !calledTools.has(name)
            );
            if (
                missingRequiredTools.length > 0 &&
                requiredToolReminders < MAX_REQUIRED_TOOL_REMINDERS
            ) {
                requiredToolReminders += 1;
                history.push({
                    role: "system",
                    content: [
                        "Required-tool guard: the user explicitly required tools that have not been called.",
                        `Call these tools before answering: ${missingRequiredTools.join(", ")}.`,
                        "Do not claim that tools are unavailable when they are present in the tool list.",
                    ].join("\n"),
                });
                continue;
            }

            const toolEvidence = history
                .filter((message) => message.role === "tool")
                .map((message) => message.content)
                .join("\n");
            const presentationIssues = [
                ...findPublicReplyIssues(
                    res.text,
                    latestUserText(history),
                    tools.map((tool) => tool.name)
                ),
                ...findEvidenceClaimIssues(res.text, toolEvidence),
            ];
            if (
                presentationIssues.length > 0 &&
                presentationReminders < MAX_PRESENTATION_REMINDERS
            ) {
                presentationReminders += 1;
                history.push({
                    role: "system",
                    content: [
                        "Customer-presentation and data-minimization guard: rewrite the draft before answering.",
                        `Remove or translate these issues: ${presentationIssues.join(", ")}.`,
                        ...publicRewriteGuidance(presentationIssues),
                        "Keep verified findings, caveats and public source links, but use plain customer language.",
                        "Do not mention this guard, internal tools, implementation details or removed values.",
                    ].join("\n"),
                });
                continue;
            }

            const requiredCitations = new Set(verifiedArticleUrls);
            if (/(?:quyết định|decision|päätös)/iu.test(res.text)) {
                for (const url of decisionUrlsInHistory(history)) {
                    requiredCitations.add(url);
                }
            }
            const missingVerifiedCitations = [...requiredCitations].filter(
                (url) => !res.text.includes(url)
            );
            if (
                missingVerifiedCitations.length > 0 &&
                citationReminders < MAX_CITATION_REMINDERS
            ) {
                citationReminders += 1;
                history.push({
                    role: "system",
                    content: [
                        "Citation guard: verified public evidence was used, but its official URL is missing from the draft.",
                        `Include these exact URLs next to the supported claims: ${missingVerifiedCitations.join(", ")}.`,
                    ].join("\n"),
                });
                continue;
            }
            if (missingVerifiedCitations.length > 0) {
                return sanitizePublicReply([
                    res.text,
                    "",
                    "Nguồn đã xác minh:",
                    ...missingVerifiedCitations.map((url) => `- ${url}`),
                ].join("\n"), presentationIssues);
            }

            return sanitizePublicReply(res.text, presentationIssues);
        }

        for (const call of res.toolCalls) {
            const signature = stableToolSignature(call.name, call.args);
            const signatureCount = signatureCounts.get(signature) ?? 0;
            signatureCounts.set(signature, signatureCount + 1);

            if (totalToolCalls >= maxTotalToolCalls) {
                history.push({
                    role: "tool",
                    toolCallId: call.id,
                    name: call.name,
                    content:
                        "Error: The total tool-call safety limit was reached. Use the results already gathered.",
                });
                continue;
            }
            if (signatureCount >= MAX_IDENTICAL_TOOL_CALLS) {
                history.push({
                    role: "tool",
                    toolCallId: call.id,
                    name: call.name,
                    content:
                        "Error: This identical tool call already ran twice. Change the query or use another available result.",
                });
                continue;
            }

            totalToolCalls += 1;
            if (AGENT_DEBUG) console.log(`Tool call: ${call.name}`);
            const output = await hub
                .call(call.name, call.args)
                .catch((error: Error) => `Error: ${error.message}`);
            if (AGENT_DEBUG) {
                console.log("Tool result:", {
                    name: call.name,
                    characters: output.length,
                    failed: output.startsWith("Error:"),
                });
            }
            history.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: output,
            });
            calledTools.add(call.name);

            if (
                call.name === "get_property_article_context" &&
                !output.startsWith("Error:")
            ) {
                const requestedUrl =
                    typeof call.args.url === "string"
                        ? canonicalArticleUrl(call.args.url)
                        : null;
                if (requestedUrl) verifiedArticleUrls.add(requestedUrl);
            }
        }
    }

    const remainingUnverifiedUrls = suppliedArticleUrls.filter(
        (url) => !verifiedArticleUrls.has(url)
    );
    if (remainingUnverifiedUrls.length > 0) {
        return "Mình chưa thể đọc và xác minh nội dung URL bài báo này, nên không thể mô tả hoặc kết luận về bài đó một cách đáng tin cậy.";
    }

    const finalResponse = await llm.chat(
        [
            { role: "system", content: buildSystemPrompt() },
            ...history,
            {
                role: "system",
                content: `The agent safety limit has been reached after ${totalToolCalls} tool calls. Answer now using only the available tool results. Clearly identify any requested checks that remain incomplete; do not claim the tools were unavailable.`,
            },
        ],
        []
    );

    const baseFinalText =
        finalResponse.text ||
        "Unable to produce a final answer from the available tool results.";
    const requiredFinalCitations = new Set(verifiedArticleUrls);
    if (/(?:quyết định|decision|päätös)/iu.test(baseFinalText)) {
        for (const url of decisionUrlsInHistory(history)) {
            requiredFinalCitations.add(url);
        }
    }
    const missingFinalCitations = [...requiredFinalCitations].filter(
        (url) => !baseFinalText.includes(url)
    );
    const finalText =
        missingFinalCitations.length === 0
            ? baseFinalText
            : [
                  baseFinalText,
                  "",
                  "Nguồn đã xác minh:",
                  ...missingFinalCitations.map((url) => `- ${url}`),
              ].join("\n");
    history.push({ role: "assistant", content: finalText });
    const finalToolEvidence = history
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
        .join("\n");
    const finalPresentationIssues = [
        ...findPublicReplyIssues(
            finalText,
            latestUserText(history),
            tools.map((tool) => tool.name)
        ),
        ...findEvidenceClaimIssues(finalText, finalToolEvidence),
    ];
    return sanitizePublicReply(finalText, finalPresentationIssues);
}
