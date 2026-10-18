import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "./agent.js";
import type { McpHub } from "./mcp-client.js";
import {
    findEvidenceClaimIssues,
    findPublicReplyIssues,
    sanitizePublicReply,
} from "./public-output.js";
import type {
    ChatMessage,
    LLMProvider,
    LLMResponse,
    ToolDef,
} from "./llm/types.js";

class SequenceLlm implements LLMProvider {
    readonly calls: Array<{ messages: ChatMessage[]; tools: ToolDef[] }> = [];

    constructor(private readonly responses: LLMResponse[]) {}

    async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMResponse> {
        this.calls.push({ messages, tools });
        const response = this.responses.shift();
        if (!response) throw new Error("No mock LLM response remains.");
        return response;
    }
}

function tool(name: string): ToolDef {
    return { name, inputSchema: { type: "object", properties: {} } };
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
    return { id, name, args };
}

function mockHub(called: string[]): McpHub {
    return {
        async call(name: string) {
            called.push(name);
            return JSON.stringify({ ok: true, tool: name });
        },
    } as unknown as McpHub;
}

test("allows a comprehensive workflow to continue beyond five tool rounds", async () => {
    const toolNames = [
        "helsinki_lookup_local_parcel",
        "risk_get_property_profile",
        "risk_check_live_water_disruptions",
        "helsinki_search_parcel_decisions",
        "search_property_incident_articles",
        "get_property_article_context",
    ];
    const llm = new SequenceLlm([
        ...toolNames.map((name, index) => ({
            text: "",
            toolCalls: [call(String(index), name)],
        })),
        { text: "Báo cáo hoàn chỉnh", toolCalls: [] },
    ]);
    const called: string[] = [];
    const history: ChatMessage[] = [
        { role: "user", content: "Lập báo cáo đầy đủ cho Opastinsilta 2." },
    ];

    const reply = await runAgent(llm, mockHub(called), toolNames.map(tool), history);

    assert.equal(reply, "Báo cáo hoàn chỉnh");
    assert.deepEqual(called, toolNames);
    assert.equal(llm.calls.length, 7);
});

test("reminds the model to call tools explicitly required by the user", async () => {
    const llm = new SequenceLlm([
        { text: "Tôi không thể gọi thêm công cụ.", toolCalls: [] },
        {
            text: "",
            toolCalls: [call("risk", "risk_get_property_profile", { address: "Opastinsilta 2" })],
        },
        {
            text: "",
            toolCalls: [
                call("water", "risk_check_live_water_disruptions", {
                    address: "Opastinsilta 2",
                }),
            ],
        },
        { text: "Đã kiểm tra đủ.", toolCalls: [] },
    ]);
    const called: string[] = [];
    const tools = [
        tool("risk_get_property_profile"),
        tool("risk_check_live_water_disruptions"),
    ];
    const history: ChatMessage[] = [
        {
            role: "user",
            content:
                "Hãy dùng risk_get_property_profile. Bắt buộc gọi risk_check_live_water_disruptions.",
        },
    ];

    const reply = await runAgent(llm, mockHub(called), tools, history);

    assert.equal(reply, "Đã kiểm tra đủ.");
    assert.deepEqual(called, [
        "risk_get_property_profile",
        "risk_check_live_water_disruptions",
    ]);
    assert.ok(
        history.some(
            (message) =>
                message.role === "system" &&
                message.content.includes("Required-tool guard")
        )
    );
});

test("blocks a third identical tool call without invoking the MCP again", async () => {
    const repeated = call("same", "risk_get_property_profile", {
        address: "Opastinsilta 2",
    });
    const llm = new SequenceLlm([
        { text: "", toolCalls: [{ ...repeated, id: "1" }] },
        { text: "", toolCalls: [{ ...repeated, id: "2" }] },
        { text: "", toolCalls: [{ ...repeated, id: "3" }] },
        { text: "Dừng lặp.", toolCalls: [] },
    ]);
    const called: string[] = [];
    const history: ChatMessage[] = [{ role: "user", content: "Kiểm tra risk." }];

    const reply = await runAgent(
        llm,
        mockHub(called),
        [tool("risk_get_property_profile")],
        history
    );

    assert.equal(reply, "Dừng lặp.");
    assert.equal(called.length, 2);
    assert.ok(
        history.some(
            (message) =>
                message.role === "tool" &&
                message.content.includes("identical tool call")
        )
    );
});

test("requires the final answer to include a verified article URL", async () => {
    const articleUrl = "https://www.hs.fi/pkseutu/art-2000006643663.html";
    const llm = new SequenceLlm([
        {
            text: "",
            toolCalls: [
                call("article", "get_property_article_context", {
                    url: articleUrl,
                    address: "Opastinsilta 2",
                }),
            ],
        },
        { text: "Bài báo đã xác minh nhưng chưa có link.", toolCalls: [] },
        { text: `Bài báo đã xác minh: ${articleUrl}`, toolCalls: [] },
    ]);
    const called: string[] = [];
    const history: ChatMessage[] = [
        { role: "user", content: "Kiểm tra bài báo cho Opastinsilta 2." },
    ];

    const reply = await runAgent(
        llm,
        mockHub(called),
        [tool("get_property_article_context")],
        history
    );

    assert.ok(reply.includes(articleUrl));
    assert.ok(
        history.some(
            (message) =>
                message.role === "system" &&
                message.content.includes("Citation guard")
        )
    );
});

test("rewrites a technical draft for a normal customer", async () => {
    const technicalDraft = [
        "Tool: risk_get_property_profile",
        "Status: UNKNOWN_REQUIRES_LIVE_CHECK",
        "Property identifier: 09101700230003",
    ].join("\n");
    const customerDraft = [
        "## Tóm tắt",
        "Chưa đủ dữ liệu hiện tại để kết luận về tình trạng cấp nước.",
        "Bạn nên kiểm tra lại với đơn vị quản lý tòa nhà trước khi ký hợp đồng.",
    ].join("\n");
    const llm = new SequenceLlm([
        { text: technicalDraft, toolCalls: [] },
        { text: customerDraft, toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
        {
            role: "user",
            content: "Tôi đang cân nhắc mua nhà tại Opastinsilta 2.",
        },
    ];

    const reply = await runAgent(
        llm,
        mockHub([]),
        [tool("risk_get_property_profile")],
        history
    );

    assert.equal(reply, customerDraft);
    assert.ok(
        history.some(
            (message) =>
                message.role === "system" &&
                message.content.includes("Customer-presentation")
        )
    );
});

test("allows a property identifier when the customer explicitly requests it", () => {
    const issues = findPublicReplyIssues(
        "Mã thửa là 91-17-23-3.",
        "Cho tôi mã thửa của bất động sản này.",
        []
    );

    assert.equal(
        issues.includes("property identifier not requested by the customer"),
        false
    );
});

test("redacts secret-like values and internal paths as a final safeguard", () => {
    const sanitized = sanitizePublicReply(
        "BRAVE_SEARCH_API_KEY=replace-with-test-key C:\\Project\\Hackathon\\private.json risk_get_property_profile"
    );

    assert.equal(sanitized.includes("replace-with-test-key"), false);
    assert.equal(sanitized.includes("C:\\Project"), false);
    assert.equal(sanitized.includes("risk_get_property_profile"), false);
});

test("normalizes unsupported customer-facing labels and units", () => {
    const sanitized = sanitizePublicReply(
        "Đây là nhà chung cư rộng 4.467 $m^2$. Sưởi tập trung (District Heating), giúp giảm thiểu rủi ro cháy tại chỗ.",
        [
            "building use inferred from an unmapped purpose code",
            "fire-safety benefit inferred from the heating method",
        ]
    );

    assert.equal(sanitized.includes("nhà chung cư"), false);
    assert.equal(sanitized.includes("$m^2$"), false);
    assert.ok(sanitized.includes("m²"));
    assert.equal(sanitized.includes("giảm thiểu rủi ro cháy"), false);
});

test("flags customer claims that contradict explicit risk-data limitations", () => {
    const reply = [
        "Khu vực này an toàn và hạ tầng ổn định.",
        "Radon ở mức rất thấp.",
        "Rủi ro cháy của tòa nhà rất thấp.",
        "Điện lưới có độ tin cậy cao.",
        "Sự cố cấp nước: không có sự cố.",
    ].join("\n");
    const evidence = [
        "UNAVAILABLE_FOR_POSTAL_CODE",
        "NOT_ASSESSED_FROM_CURRENT_DATA",
        "NO_MAPPED_EVENT_AT_POINT",
    ].join("\n");

    const issues = findEvidenceClaimIssues(reply, evidence);

    assert.equal(issues.length, 5);
});

test("requires a building-level caveat for postal-code radon statistics", () => {
    const evidence = JSON.stringify({
        factor: "indoor_radon_radiation",
        scope: { level: "postal_code" },
    });
    const draft = "**Khí Radon:** Mức radon của mã bưu điện này rất thấp.";
    const issues = findEvidenceClaimIssues(draft, evidence);
    const sanitized = sanitizePublicReply(draft, issues);

    assert.ok(
        issues.includes("postal-code radon result missing a building-level caveat")
    );
    assert.ok(sanitized.includes("không phải phép đo tại tòa nhà hoặc căn hộ"));
});

test("requires official decision links when the answer mentions decisions", async () => {
    const decisionUrl =
        "https://paatokset.hel.fi/fi/asia/hel-2022-010145?paatos=example";
    const llm = new SequenceLlm([
        {
            text: "",
            toolCalls: [call("decision", "helsinki_search_parcel_decisions")],
        },
        { text: "Có một quyết định hành chính liên quan.", toolCalls: [] },
        {
            text: `Có một quyết định hành chính liên quan: ${decisionUrl}`,
            toolCalls: [],
        },
    ]);
    const history: ChatMessage[] = [
        { role: "user", content: "Kiểm tra quyết định cho Opastinsilta 2." },
    ];
    const hub = {
        async call() {
            return JSON.stringify({ officialUrl: decisionUrl });
        },
    } as unknown as McpHub;

    const reply = await runAgent(
        llm,
        hub,
        [tool("helsinki_search_parcel_decisions")],
        history
    );

    assert.ok(reply.includes(decisionUrl));
});
