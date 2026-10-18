import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  compactParcel,
  extractParcelIdentifiers,
  formatParcelIdentifier,
  normalizeParcelIdentifier,
  ParcelIndex,
} from "./parcel-index.js";
import {
  buildDualPassSearchPlans,
  selectDualPassResults,
  type DualPassSearchPlan,
} from "./decision-search.js";
import { normalizeAddressKey } from "./address-normalizer.js";
import {
  classifyParcelDecision,
  type DecisionTextField,
} from "./decision-matcher.js";

const server = new McpServer({
  name: "helsinki-decisions-mcp",
  version: "1.0.0",
});

const DEFAULT_API_URL =
  "https://paatokset-elastic-proxy.api.hel.ninja/paatokset_decisions/_search";
const API_URL = process.env.HELSINKI_DECISIONS_API_URL?.trim() || DEFAULT_API_URL;
const MAX_RESULT_CHARACTERS = 60_000;
const MAX_SECTION_CHARACTERS = 20_000;
const MAX_MATCHING_TEXT_CHARACTERS = 200_000;
const MAX_API_RESPONSE_CHARACTERS = 5_000_000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 100;
const DECISION_SOURCE_FIELDS = [
  "_language",
  "id",
  "issue_id",
  "subject",
  "issue_subject",
  "category_name",
  "top_category_name",
  "organization_name",
  "meeting_date",
  "decision_url",
  "decision_content",
  "search_api_language",
] as const;

interface SearchHit {
  _id: string;
  _score?: number | null;
  _source?: Record<string, unknown>;
}

interface SearchResponse {
  hits?: {
    total?: number | { value?: number };
    hits?: SearchHit[];
  };
}

interface SearchApiResult {
  data: SearchResponse;
  fetchedAt: string;
  cacheHit: boolean;
}

interface SearchCacheEntry {
  data: SearchResponse;
  fetchedAt: string;
  expiresAt: number;
}

interface ParcelMatchContext {
  selectedParcelIdentifier: string;
  addresses: string[];
}

let parcelIndex: ParcelIndex | undefined;
const searchCache = new Map<string, SearchCacheEntry>();

function getParcelIndex(): ParcelIndex {
  parcelIndex ??= new ParcelIndex();
  return parcelIndex;
}

function result(data: unknown) {
  const text = JSON.stringify(data);

  if (text.length > MAX_RESULT_CHARACTERS) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Helsinki decision result is too large for the LLM context.",
            resultCharacters: text.length,
            maximumCharacters: MAX_RESULT_CHARACTERS,
            suggestion: "Use a smaller result limit or fetch one decision by its decisionId.",
          }),
        },
      ],
    };
  }

  return { content: [{ type: "text" as const, text }] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pruneSearchCache(now: number): void {
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }

  while (searchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldestKey = searchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    searchCache.delete(oldestKey);
  }
}

async function searchApi(payload: Record<string, unknown>): Promise<SearchApiResult> {
  const cacheKey = JSON.stringify(payload);
  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, cacheHit: true };
  }
  pruneSearchCache(now);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: cacheKey,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        const retryable = [429, 502, 503, 504].includes(response.status);
        if (retryable && attempt < 2) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw new Error(
          `Helsinki Decisions API returned HTTP ${response.status}: ${detail}`
        );
      }

      const raw = await response.text();
      if (raw.length > MAX_API_RESPONSE_CHARACTERS) {
        throw new Error(
          `Helsinki Decisions API response exceeded ${MAX_API_RESPONSE_CHARACTERS} characters.`
        );
      }

      const data = JSON.parse(raw) as SearchResponse;
      const fetchedAt = new Date().toISOString();
      searchCache.set(cacheKey, {
        data,
        fetchedAt,
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      });
      return { data, fetchedAt, cacheHit: false };
    } catch (error) {
      if (attempt >= 2 || (error instanceof Error && error.message.startsWith("Helsinki Decisions API returned HTTP 4"))) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
    }
  }

  throw new Error("Helsinki Decisions API request failed after retries.");
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function firstString(value: unknown): string | null {
  return strings(value)[0] ?? null;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    auml: "ä",
    Auml: "Ä",
    aring: "å",
    Aring: "Å",
    ouml: "ö",
    Ouml: "Ö",
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name] ?? match);
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function extractDecisionSections(html: string) {
  const headings: Array<{
    title: string;
    start: number;
    contentStart: number;
  }> = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

  for (const match of html.matchAll(headingPattern)) {
    headings.push({
      title: htmlToText(match[2]).toLocaleLowerCase("fi"),
      start: match.index ?? 0,
      contentStart: (match.index ?? 0) + match[0].length,
    });
  }

  const sections: { decision: string[]; grounds: string[] } = {
    decision: [],
    grounds: [],
  };

  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? html.length;
    const text = htmlToText(html.slice(heading.contentStart, end));
    if (!text) return;

    if (heading.title === "päätös") sections.decision.push(text);
    if (heading.title.includes("perustelut")) sections.grounds.push(text);
  });

  const decision = sections.decision.join("\n\n");
  const grounds = sections.grounds.join("\n\n");
  const usedFallback = !decision && !grounds;
  const combined = (usedFallback ? htmlToText(html) : [decision, grounds].filter(Boolean).join("\n\n"))
    .slice(0, MAX_SECTION_CHARACTERS);

  return {
    decision: decision.slice(0, MAX_SECTION_CHARACTERS),
    grounds: grounds.slice(0, MAX_SECTION_CHARACTERS),
    combined,
    usedFallback,
  };
}

function normalizeDate(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && first.trim()) {
    const numeric = Number(first);
    if (!Number.isFinite(numeric)) return first;
    value = numeric;
  } else {
    value = first;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toISOString();
}

function sourceText(source: Record<string, unknown>): string {
  return [
    ...strings(source.subject),
    ...strings(source.issue_subject),
    ...strings(source.decision_content),
  ].join("\n");
}

function decisionTextFields(
  source: Record<string, unknown>,
  decisionContent: string
): DecisionTextField[] {
  return [
    ...strings(source.subject).map((text) => ({ field: "subject" as const, text })),
    ...strings(source.issue_subject).map((text) => ({
      field: "issue_subject" as const,
      text,
    })),
    ...(decisionContent
      ? [{ field: "decision_content" as const, text: decisionContent }]
      : []),
  ];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.normalize("NFKC").toLocaleLowerCase("fi");
    if (!unique.has(key)) unique.set(key, trimmed);
  }
  return [...unique.values()];
}

function totalHits(response: SearchResponse): number | null {
  const total = response.hits?.total;
  return typeof total === "number" ? total : total?.value ?? null;
}

function decisionSearchPayload(
  query: string,
  language: "fi" | "sv",
  size: number,
  phrase = false,
  offset = 0
): Record<string, unknown> {
  return {
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query,
              fields: ["subject^3", "issue_subject^2", "decision_content"],
              operator: "and",
              ...(phrase ? { type: "phrase" } : {}),
            },
          },
        ],
        filter: [{ term: { _language: language } }],
      },
    },
    from: offset,
    size,
    sort: [{ _score: { order: "desc" } }, { meeting_date: { order: "desc" } }],
    _source: DECISION_SOURCE_FIELDS,
  };
}

async function runParcelSearchPlans(
  plans: DualPassSearchPlan[],
  language: "fi" | "sv",
  size: number
): Promise<Array<{
  plan: DualPassSearchPlan;
  response: SearchApiResult;
}>> {
  const results: Array<{
    plan: DualPassSearchPlan;
    response: SearchApiResult;
  }> = [];

  for (let index = 0; index < plans.length; index += 3) {
    const batch = plans.slice(index, index + 3);
    const batchResults = await Promise.all(
      batch.map(async (plan) => ({
        plan,
        response: await searchApi(
          decisionSearchPayload(plan.query, language, size, plan.phrase)
        ),
      }))
    );
    results.push(...batchResults);
  }

  return results;
}

function normalizedDecision(
  hit: SearchHit,
  includeSections: boolean,
  matchContext?: ParcelMatchContext
) {
  const source = hit._source ?? {};
  const html = strings(source.decision_content).join("\n");
  const sections = extractDecisionSections(html);
  const textForMatching = [sourceText(source), sections.combined].join("\n");
  const index = getParcelIndex();
  const matches = index.findMatchesInText(textForMatching).map((match) => ({
    matchMethod: match.matchMethod,
    matchedValue: match.matchedValue,
    parcel: compactParcel(match.parcel),
  }));
  const parcelReferences = extractParcelIdentifiers(textForMatching).map((reference) => ({
    ...reference,
    availableInLocalDataset: Boolean(index.findByIdentifier(reference.normalized)),
  }));
  const relativeUrl = firstString(source.decision_url);

  return {
    decisionId: hit._id,
    issueId: firstString(source.issue_id),
    language:
      firstString(source._language) ?? firstString(source.search_api_language),
    subject: firstString(source.subject),
    issueSubject: firstString(source.issue_subject),
    category: firstString(source.category_name),
    topCategory: firstString(source.top_category_name),
    organization: firstString(source.organization_name),
    meetingDate: normalizeDate(source.meeting_date),
    officialUrl: relativeUrl
      ? new URL(relativeUrl, "https://paatokset.hel.fi").toString()
      : null,
    parcelReferences,
    localParcelMatches: matches,
    contentAvailable: Boolean(html),
    ...(matchContext
      ? {
          match: classifyParcelDecision({
            selectedParcelIdentifier: matchContext.selectedParcelIdentifier,
            selectedAddresses: matchContext.addresses,
            fields: decisionTextFields(
              source,
              htmlToText(html).slice(0, MAX_MATCHING_TEXT_CHARACTERS)
            ),
          }),
        }
      : {}),
    ...(includeSections
      ? {
          operativeSections: {
            decision: sections.decision,
            grounds: sections.grounds,
            usedFallback: sections.usedFallback,
          },
        }
      : {
          operativeExcerpt: sections.combined.slice(0, 700),
        }),
  };
}

server.tool(
  "helsinki_search_decisions",
  "Search official City of Helsinki municipal decisions about land leases, property sales, zoning or construction. Returns compact decision metadata and local parcel matches without exposing raw HTML.",
  {
    query: z.string().min(2).max(300)
      .describe("Finnish search terms work best, for example 'Kluuvi maanvuokra'."),
    language: z.enum(["fi", "sv"]).default("fi"),
    limit: z.number().int().min(1).max(10).default(5),
    offset: z.number().int().min(0).max(1000).default(0),
  },
  async ({ query, language, limit, offset }) => {
    const response = await searchApi(
      decisionSearchPayload(query, language, limit, false, offset)
    );
    const data = response.data;
    const index = getParcelIndex();

    return result({
      source: "City of Helsinki Decisions API",
      query,
      language,
      offset,
      returnedDecisions: data.hits?.hits?.length ?? 0,
      totalMatches: totalHits(data),
      provenance: {
        retrievedAt: response.fetchedAt,
        cacheHit: response.cacheHit,
      },
      localDataset: index.metadata,
      decisions: (data.hits?.hits ?? []).map((hit) =>
        normalizedDecision(hit, false)
      ),
    });
  }
);

server.tool(
  "helsinki_search_parcel_decisions",
  "Resolve a Helsinki parcel from a property identifier or apartment/listing address, normalize it to the official parcel-level address, then run exactly two quoted phrase searches: cadastral ID and street address. Results are deduplicated and evidence-classified.",
  {
    parcelIdentifier: z.string().min(3).max(64).optional()
      .describe("Optional Finnish property identifier, for example 91-12-369-1."),
    address: z.string().min(2).max(200).optional()
      .describe("Street, listing or apartment address, for example 'Viipurinkatu 14 C 23'. Unit, staircase, postal-code and city suffixes are removed before searching."),
    language: z.enum(["fi", "sv"]).default("fi"),
    limit: z.number().int().min(1).max(25).default(10),
  },
  async ({ parcelIdentifier, address, language, limit }) => {
    if (!parcelIdentifier && !address) {
      throw new Error("Provide parcelIdentifier or address.");
    }

    const index = getParcelIndex();
    const addressResolution = address ? index.resolveAddress(address) : null;
    let normalizedParcelIdentifier = parcelIdentifier
      ? normalizeParcelIdentifier(parcelIdentifier)
      : null;
    if (parcelIdentifier && !normalizedParcelIdentifier) {
      throw new Error(`Invalid Finnish property identifier: ${parcelIdentifier}`);
    }

    if (!normalizedParcelIdentifier) {
      if (addressResolution?.parcels.length === 0) {
        return result({
          source: "Local Ryhti parcel snapshot",
          resolutionStatus: "not_found_in_local_snapshot",
          addressResolution,
          suggestion:
            "Resolve the official property identifier with live Ryhti/MML data, then call this tool with parcelIdentifier and address.",
        });
      }
      if ((addressResolution?.parcels.length ?? 0) > 1) {
        return result({
          source: "Local Ryhti parcel snapshot",
          resolutionStatus: "ambiguous_address",
          addressResolution: addressResolution
            ? {
                ...addressResolution,
                parcels: addressResolution.parcels.map(compactParcel),
              }
            : null,
          suggestion: "Choose one property identifier before searching decisions.",
        });
      }
      normalizedParcelIdentifier =
        addressResolution?.parcels[0]?.kiinteistotunnus ?? null;
    }

    if (!normalizedParcelIdentifier) {
      throw new Error("Unable to resolve a property identifier.");
    }

    const localParcel = index.findByIdentifier(normalizedParcelIdentifier);
    const addressParcelIdentifiers = new Set(
      addressResolution?.parcels.map((parcel) => parcel.kiinteistotunnus) ?? []
    );
    if (
      addressParcelIdentifiers.size > 0 &&
      !addressParcelIdentifiers.has(normalizedParcelIdentifier)
    ) {
      return result({
        source: "Local Ryhti parcel snapshot",
        resolutionStatus: "parcel_address_conflict",
        suppliedParcelIdentifier: parcelIdentifier,
        normalizedParcelIdentifier,
        addressResolution: addressResolution
          ? {
              ...addressResolution,
              parcels: addressResolution.parcels.map(compactParcel),
            }
          : null,
        suggestion: "Confirm the correct parcel before searching decisions.",
      });
    }

    const formattedParcelIdentifier =
      localParcel?.text_format ?? formatParcelIdentifier(normalizedParcelIdentifier);
    if (!formattedParcelIdentifier) {
      throw new Error(`Unable to format property identifier: ${normalizedParcelIdentifier}`);
    }

    const fallbackOfficialAddress = addressResolution
      ? addressResolution.parcels
          .flatMap((parcel) => parcel.addresses)
          .find(
            (candidate) =>
              normalizeAddressKey(candidate) ===
              normalizeAddressKey(addressResolution.normalizedSearchAddress)
          ) ?? null
      : null;
    if (
      address &&
      localParcel &&
      !addressResolution?.officialAddress &&
      !fallbackOfficialAddress
    ) {
      return result({
        source: "Local Ryhti parcel snapshot",
        resolutionStatus: "parcel_address_unverified",
        normalizedParcelIdentifier,
        suppliedAddress: address,
        normalizedSearchAddress: addressResolution?.normalizedSearchAddress,
        parcel: compactParcel(localParcel),
        suggestion:
          "The supplied address does not match an official address on this local parcel. Confirm the address or property identifier before searching decisions.",
      });
    }

    const officialAddress =
      addressResolution?.officialAddress ??
      fallbackOfficialAddress ??
      (!localParcel ? addressResolution?.normalizedSearchAddress : null) ??
      localParcel?.addresses[0] ??
      null;
    if (!officialAddress) {
      return result({
        source: "Local Ryhti parcel snapshot",
        resolutionStatus: "official_address_required",
        normalizedParcelIdentifier,
        suggestion:
          "Provide the official street address so the required address phrase pass can run.",
      });
    }

    const plans = buildDualPassSearchPlans(
      formattedParcelIdentifier,
      officialAddress
    );
    const planResults = await runParcelSearchPlans(plans, language, 50);
    const candidates = new Map<
      string,
      { hit: SearchHit; discoveredBy: DualPassSearchPlan[] }
    >();

    for (const { plan, response } of planResults) {
      for (const hit of response.data.hits?.hits ?? []) {
        const existing = candidates.get(hit._id);
        if (existing) {
          existing.discoveredBy.push(plan);
        } else {
          candidates.set(hit._id, { hit, discoveredBy: [plan] });
        }
      }
    }

    const matchContext: ParcelMatchContext = {
      selectedParcelIdentifier: normalizedParcelIdentifier,
      addresses: [officialAddress],
    };
    const rankedDecisions = [...candidates.values()]
      .map(({ hit, discoveredBy }) => {
        const normalized = normalizedDecision(hit, false, matchContext);
        const { localParcelMatches: _localParcelMatches, ...decision } = normalized;
        return {
          ...decision,
          foundByPasses: discoveredBy.map(({ stage }) => stage),
        };
      })
      .sort((left, right) => {
        const scoreDifference =
          (right.match?.score ?? 0) - (left.match?.score ?? 0);
        if (scoreDifference !== 0) return scoreDifference;
        return (
          (Date.parse(right.meetingDate ?? "") || 0) -
          (Date.parse(left.meetingDate ?? "") || 0)
        );
      });
    const decisions = selectDualPassResults(rankedDecisions, limit);
    const matchSummary = decisions.reduce<Record<string, number>>(
      (summary, decision) => {
        const type = decision.match?.matchType ?? "unclassified";
        summary[type] = (summary[type] ?? 0) + 1;
        return summary;
      },
      {}
    );
    const candidateMatchSummary = rankedDecisions.reduce<Record<string, number>>(
      (summary, decision) => {
        const type = decision.match?.matchType ?? "unclassified";
        summary[type] = (summary[type] ?? 0) + 1;
        return summary;
      },
      {}
    );

    return result({
      source: "City of Helsinki Decisions API + local Ryhti parcel snapshot",
      resolutionStatus: "resolved",
      parcelContext: {
        rawUserQuery: address ?? parcelIdentifier,
        rawParcelIdentifier: parcelIdentifier ?? null,
        kiinteistotunnus: normalizedParcelIdentifier,
        textFormat: formattedParcelIdentifier,
        officialAddress,
        normalizedSearchAddress: officialAddress,
        discardedAddressSuffix: addressResolution?.discardedSuffix ?? null,
        addressResolutionMethod: addressResolution?.resolutionMethod ?? "local_parcel_primary_address",
        normalizationMethod:
          (parcelIdentifier ?? formattedParcelIdentifier).replace(/\s/g, "").includes("-")
            ? "component_padding_3_3_4_4"
            : "already_14_digits",
        normalizationValidatedAgainstLocalDataset: Boolean(localParcel),
        availableInLocalDataset: Boolean(localParcel),
        parcel: localParcel ? compactParcel(localParcel) : null,
      },
      language,
      returnedDecisions: decisions.length,
      uniqueCandidatesFound: candidates.size,
      resultsTruncated: candidates.size > decisions.length,
      matchSummary,
      candidateMatchSummary,
      searchExecution: {
        strategy: "dual_pass_quoted_phrase",
        exactPassCount: 2,
        passes: planResults.map(({ plan, response }) => ({
          stage: plan.stage,
          query: plan.query,
          phraseType: true,
          totalMatches: totalHits(response.data),
          fetchedAt: response.fetchedAt,
          cacheHit: response.cacheHit,
        })),
        totalUniqueDecisionsFound: candidates.size,
      },
      decisions,
    });
  }
);

server.tool(
  "helsinki_get_decision_context",
  "Fetch one Helsinki decision by decisionId, extract the operative decision and grounds, and optionally verify it against the same parcel ID and normalized official address used in the dual-pass search.",
  {
    decisionId: z.string().min(1).max(200)
      .describe("Exact decisionId returned by helsinki_search_decisions."),
    parcelIdentifier: z.string().min(3).max(64).optional(),
    address: z.string().min(2).max(200).optional(),
  },
  async ({ decisionId, parcelIdentifier, address }) => {
    const response = await searchApi({
      query: { ids: { values: [decisionId] } },
      size: 1,
      _source: DECISION_SOURCE_FIELDS,
    });
    const data = response.data;
    const hit = data.hits?.hits?.[0];
    if (!hit) throw new Error(`Helsinki decision not found: ${decisionId}`);

    let matchContext: ParcelMatchContext | undefined;
    if (parcelIdentifier) {
      const normalized = normalizeParcelIdentifier(parcelIdentifier);
      if (!normalized) {
        throw new Error(`Invalid Finnish property identifier: ${parcelIdentifier}`);
      }
      const index = getParcelIndex();
      const localParcel = index.findByIdentifier(normalized);
      const addressResolution = address ? index.resolveAddress(address) : null;
      matchContext = {
        selectedParcelIdentifier: normalized,
        addresses: uniqueStrings([
          addressResolution?.officialAddress,
          addressResolution?.normalizedSearchAddress,
          ...(localParcel?.addresses ?? []),
        ]),
      };
    }

    return result({
      source: "City of Helsinki Decisions API + local Ryhti parcel snapshot",
      provenance: {
        retrievedAt: response.fetchedAt,
        cacheHit: response.cacheHit,
      },
      decision: normalizedDecision(hit, true, matchContext),
    });
  }
);

server.tool(
  "helsinki_lookup_local_parcel",
  "Look up the local bbox parcel snapshot by a Finnish property identifier or a listing/apartment address. Address lookup strips unit, staircase, postal-code and city suffixes by resolving the longest official address prefix.",
  {
    parcelIdentifier: z.string().max(64).optional(),
    address: z.string().max(200).optional(),
  },
  async ({ parcelIdentifier, address }) => {
    if (!parcelIdentifier && !address) {
      throw new Error("Provide parcelIdentifier or address.");
    }

    const index = getParcelIndex();
    const addressResolution = address ? index.resolveAddress(address) : null;
    const matches = parcelIdentifier
      ? [index.findByIdentifier(parcelIdentifier)].filter((item) => item !== null)
      : addressResolution?.parcels ?? [];

    return result({
      source: "Local Ryhti parcel snapshot",
      metadata: index.metadata,
      query: {
        parcelIdentifier,
        normalizedParcelIdentifier: parcelIdentifier
          ? normalizeParcelIdentifier(parcelIdentifier)
          : null,
        address,
        normalizedSearchAddress: addressResolution?.normalizedSearchAddress ?? null,
        discardedAddressSuffix: addressResolution?.discardedSuffix ?? null,
        addressResolutionMethod: addressResolution?.resolutionMethod ?? null,
      },
      returnedParcels: matches.length,
      parcels: matches.map(compactParcel),
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Helsinki Decisions MCP server started.");
}

main().catch((error) => {
  console.error("Helsinki Decisions MCP failed:", error);
  process.exitCode = 1;
});
