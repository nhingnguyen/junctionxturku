const FRIENDLY_TOOL_NAMES: Record<string, string> = {
    helsinki_lookup_local_parcel: "property lookup",
    risk_get_property_profile: "property risk check",
    risk_check_live_water_disruptions: "current water-service check",
    helsinki_search_parcel_decisions: "municipal decision search",
    search_property_incident_articles: "news search",
    get_property_article_context: "article verification",
    ryhti_get_features: "official property register",
    ryhti_get_buildings_by_permanent_identifiers: "official building register",
    mml_geocode_place: "official location search",
    mml_find_nearby_buildings: "nearby-building search",
};

const SECRET_VALUE_PATTERNS = [
    /\b(?:sk|sk-proj)-[A-Za-z0-9_-]{12,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*\b/giu,
    /\b(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',;]+["']?/giu,
    /\b(?:OLLAMA_API_KEY|BRAVE_SEARCH_API_KEY|MML_API_KEY)\s*[:=]\s*[^\s,;]+/gu,
];

const INTERNAL_PATH_PATTERNS = [
    /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/gu,
    /(?:^|\s)\/(?:app|workspace|home|tmp)\/(?:[^\s<>]+\/?)+/gu,
];

const RAW_STATUS_PATTERN = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/gu;
const PROPERTY_IDENTIFIER_PATTERNS = [
    /\b0?91\d{11}\b/gu,
    /\b91-\d{1,3}-\d{1,4}-\d{1,4}\b/gu,
];

function userRequestedTechnicalDetails(request: string): boolean {
    return /\b(?:technical|developer|debug|raw\s+json|tool|api|schema|coordinate|identifier|parcel\s+id|property\s+id|kiinteist[oö]tunnus)\b|(?:kỹ\s*thuật|lập\s*trình|gỡ\s*lỗi|dữ\s*liệu\s*thô|tên\s*công\s*cụ|tọa\s*độ|mã\s*(?:thửa|bất\s*động\s*sản|định\s*danh))/iu.test(
        request
    );
}

/** Detect implementation details that should be rewritten before customers see them. */
export function findPublicReplyIssues(
    reply: string,
    userRequest: string,
    availableToolNames: string[]
): string[] {
    const issues = new Set<string>();
    const matches = (pattern: RegExp): boolean => {
        pattern.lastIndex = 0;
        const found = pattern.test(reply);
        pattern.lastIndex = 0;
        return found;
    };

    if (SECRET_VALUE_PATTERNS.some(matches)) {
        issues.add("credential or secret-like value");
    }
    if (INTERNAL_PATH_PATTERNS.some(matches)) {
        issues.add("local or internal file path");
    }
    if (
        availableToolNames.some((name) =>
            reply.toLocaleLowerCase("en-US").includes(name.toLocaleLowerCase("en-US"))
        )
    ) {
        issues.add("internal tool name");
    }

    if (!userRequestedTechnicalDetails(userRequest)) {
        if (matches(RAW_STATUS_PATTERN)) issues.add("raw status code");
        if (PROPERTY_IDENTIFIER_PATTERNS.some(matches)) {
            issues.add("property identifier not requested by the customer");
        }
        if (
            /\b(?:search provider|tool call|query count|layer coverage|representative point|WGS ?84|ArcGIS MapServer|MCP server)\b|(?:số\s+truy\s+vấn|tên\s+công\s+cụ|điểm\s+đại\s+diện|lớp\s+dữ\s+liệu)/iu.test(
                reply
            )
        ) {
            issues.add("implementation detail");
        }
        if (/\b(?:Class\s*)?P[123]\b/iu.test(reply)) {
            issues.add("raw technical fire class");
        }

        const headingCount = reply.match(/^#{1,6}\s+/gmu)?.length ?? 0;
        if (headingCount > 5) issues.add("too many report sections");
        if (/^[^\n]*[🚩⚠✅❌🔥💧🏠📌]/gmu.test(reply)) {
            issues.add("decorative emoji");
        }
    }

    return [...issues];
}

/** Checks customer-facing claims against explicit limitations in tool output. */
export function findEvidenceClaimIssues(
    reply: string,
    toolEvidence: string
): string[] {
    const issues = new Set<string>();

    if (
        /(?:khu vực|bất động sản|tòa nhà).{0,30}(?:an toàn|ổn định|không có vấn đề)|(?:safe|stable|problem-free).{0,30}(?:property|building|area)/iu.test(
            reply
        )
    ) {
        issues.add("unsupported broad safety or stability conclusion");
    }
    if (
        /(?:rủi ro cháy|fire risk).{0,45}(?:rất thấp|thấp|very low|low)/iu.test(
            reply
        )
    ) {
        issues.add("overall fire-risk claim inferred from limited evidence");
    }
    if (
        toolEvidence.includes("UNAVAILABLE_FOR_POSTAL_CODE") &&
        /radon[\s\S]{0,100}(?:rất thấp|thấp|trung bình|cao|very low|low|medium|high)/iu.test(
            reply
        )
    ) {
        issues.add("radon level claimed despite unavailable postal-code evidence");
    }
    if (
        /(?:"level"\s*:\s*"postal_code"|"level":\s*"postal_code"|postal-code statistic)/iu.test(
            toolEvidence
        ) &&
        /radon/iu.test(reply) &&
        !/(?:không phải|không thay thế|not (?:a|the))[^\n.]{0,80}(?:phép đo|đo thực tế|measurement)[^\n.]{0,60}(?:tòa nhà|căn hộ|building|apartment)/iu.test(
            reply
        )
    ) {
        issues.add("postal-code radon result missing a building-level caveat");
    }
    if (
        toolEvidence.includes("NOT_ASSESSED_FROM_CURRENT_DATA") &&
        /(?:điện lưới|mất điện|power grid|outage)[\s\S]{0,120}(?:độ tin cậy cao|rất thấp|ổn định|high reliability|very low|stable)/iu.test(
            reply
        )
    ) {
        issues.add("property-level power reliability inferred from operator context");
    }
    const hasBroadNoWaterClaim =
        /(?:sự cố cấp nước|water (?:service|supply|disruption))[\s\S]{0,100}(?:không có sự cố|không bị gián đoạn|no (?:problem|disruption|outage))|(?:không có|không ghi nhận|no)[^\n.]{0,60}(?:sự cố|gián đoạn|outage|disruption)[^\n.]{0,30}(?:cấp nước|water)/iu.test(
            reply
        );
    const hasQualifiedWaterWording =
        /(?:bản đồ công khai|public map)[^\n]{0,180}(?:HSY|cấp nước|water)/iu.test(
            reply
        ) &&
        /(?:không bao gồm|không đánh giá|does not (?:include|assess))[^\n]{0,100}(?:nội bộ|internal)/iu.test(
            reply
        );
    if (
        toolEvidence.includes("NO_MAPPED_EVENT_AT_POINT") &&
        hasBroadNoWaterClaim &&
        !hasQualifiedWaterWording
    ) {
        issues.add("water result stated more broadly than the public map supports");
    }
    if (
        /(?:mainPurposeCode|main_purpose_code)/u.test(toolEvidence) &&
        /(?:chung cư|nhà ở|văn phòng|\bresidential\b|\bapartment building\b|\boffice building\b)/iu.test(
            reply
        )
    ) {
        issues.add("building use inferred from an unmapped purpose code");
    }
    if (
        /(?:sưởi|heating)[^\n]{0,140}(?:giảm thiểu|giảm|reduce|lower)[^\n]{0,80}(?:rủi ro cháy|fire risk)/iu.test(
            reply
        )
    ) {
        issues.add("fire-safety benefit inferred from the heating method");
    }

    return [...issues];
}

export function publicRewriteGuidance(issues: string[]): string[] {
    const guidance: string[] = [];
    const has = (issue: string) => issues.includes(issue);

    if (has("unsupported broad safety or stability conclusion")) {
        guidance.push(
            "Remove broad words such as safe, stable, problem-free, or equivalent; state only the specific observations."
        );
    }
    if (has("overall fire-risk claim inferred from limited evidence")) {
        guidance.push(
            "Do not rate overall fire risk. Material and heating attributes are not a complete fire-safety assessment."
        );
    }
    if (has("radon level claimed despite unavailable postal-code evidence")) {
        guidance.push(
            "State that radon was not available in this dataset and recommend a building-specific check; do not give a level."
        );
    }
    if (has("postal-code radon result missing a building-level caveat")) {
        guidance.push(
            "Explicitly say that the radon figure is postal-code context, not a measurement from this building or apartment."
        );
    }
    if (has("property-level power reliability inferred from operator context")) {
        guidance.push(
            "Remove the property-level power reliability claim and operator averages because they do not assess this property."
        );
    }
    if (has("water result stated more broadly than the public map supports")) {
        guidance.push(
            "Say only that the HSY public map showed no mapped service disruption at the checked place and time; internal plumbing was not assessed."
        );
    }
    if (has("building use inferred from an unmapped purpose code")) {
        guidance.push(
            "Call it a building only. Do not label it residential, apartment, or office because the purpose code was not mapped to a verified label."
        );
    }
    if (has("raw technical fire class")) {
        guidance.push("Remove the raw P1/P2/P3 fire class from the customer report.");
    }
    if (has("fire-safety benefit inferred from the heating method")) {
        guidance.push(
            "State the heating method only; remove claims that it reduces the building's fire risk."
        );
    }
    if (has("too many report sections")) {
        guidance.push("Merge the report into no more than five short sections.");
    }
    if (has("decorative emoji")) {
        guidance.push("Remove decorative emoji.");
    }

    return guidance;
}

/** Last-resort redaction after the model has had a chance to rewrite naturally. */
export function sanitizePublicReply(reply: string, issues: string[] = []): string {
    let sanitized = reply
        .replace(/\$m\^2\$/giu, "m²")
        .replace(/\$([^$\n]+)\$/gu, "$1");

    for (const pattern of SECRET_VALUE_PATTERNS) {
        sanitized = sanitized.replace(pattern, "[redacted]");
    }
    for (const pattern of INTERNAL_PATH_PATTERNS) {
        sanitized = sanitized.replace(pattern, " [internal path hidden]");
    }
    for (const [toolName, friendlyName] of Object.entries(FRIENDLY_TOOL_NAMES)) {
        sanitized = sanitized.replace(
            new RegExp(`\\b${toolName}\\b`, "giu"),
            friendlyName
        );
    }

    if (issues.includes("building use inferred from an unmapped purpose code")) {
        sanitized = sanitized
            .replace(/(?:nhà|tòa nhà)\s+chung cư/giu, "tòa nhà")
            .replace(/\b(?:residential|apartment|office) building\b/giu, "building");
    }
    if (issues.includes("fire-safety benefit inferred from the heating method")) {
        sanitized = sanitized.replace(
            /(Sưởi tập trung(?:\s*\(District Heating\))?)[^\n.]*\./giu,
            "$1."
        );
    }
    if (
        issues.includes("postal-code radon result missing a building-level caveat") &&
        /radon/iu.test(sanitized)
    ) {
        sanitized = sanitized.replace(
            /(\*\*(?:Khí\s+)?Radon:\*\*[^\n]*)(?=\n|$)/iu,
            "$1 Đây là dữ liệu khu vực, không phải phép đo tại tòa nhà hoặc căn hộ."
        );
    }

    return sanitized.trim();
}
