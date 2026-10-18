import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  INCIDENT_CATEGORIES,
  buildArticleSearchPlans,
  candidateExclusionReason,
  classifyArticleText,
  isAllowedArticleUrl,
  normalizeArticleAddress,
  type IncidentCategory,
  type SearchLanguage,
} from "./article-intelligence.js";
import {
  configuredProvider,
  providerCoverage,
  searchArticlePlan,
  type RawArticleCandidate,
  type SearchFreshness,
} from "./search-provider.js";

const server = new McpServer({
  name: "finnish-property-articles-mcp",
  version: "1.0.0",
});

const MAX_RESULT_CHARACTERS = 60_000;
const MAX_ARTICLE_RESPONSE_CHARACTERS = 2_000_000;

function result(data: unknown) {
  const text = JSON.stringify(data);
  if (text.length > MAX_RESULT_CHARACTERS) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Article result is too large for the LLM context.",
            resultCharacters: text.length,
            maximumCharacters: MAX_RESULT_CHARACTERS,
            suggestion: "Use a smaller result limit or article excerpt size.",
          }),
        },
      ],
    };
  }
  return { content: [{ type: "text" as const, text }] };
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
      .replace(/<(?:script|style|svg|noscript|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|noscript|nav|footer|header|aside)>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/article|\/section)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .join("\n");
}

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const value = html.match(pattern)?.[1];
      if (value?.trim()) return decodeHtmlEntities(value.trim());
    }
  }
  return null;
}

function articleTitle(html: string): string | null {
  return (
    metaContent(html, ["og:title", "twitter:title"]) ??
    (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ? htmlToText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      : null)
  );
}

function articlePublishedDate(html: string): string | null {
  const value =
    metaContent(html, [
      "article:published_time",
      "datePublished",
      "date",
      "pubdate",
    ]) ?? html.match(/<time\b[^>]+datetime=["']([^"']+)["']/i)?.[1] ?? null;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
}

async function fetchAllowedArticle(startUrl: string): Promise<{
  requestedUrl: string;
  finalUrl: string;
  html: string;
  fetchedAt: string;
}> {
  let currentUrl = startUrl;
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!isAllowedArticleUrl(currentUrl)) {
      throw new Error(`Article URL is not on the configured source allowlist: ${currentUrl}`);
    }
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "FinnishPropertyIntelligence/1.0 (+source-verification)",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Article redirect did not include a Location header.");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Article source returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`Unsupported article content type: ${contentType || "unknown"}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_ARTICLE_RESPONSE_CHARACTERS) {
      throw new Error("Article response exceeds the configured size limit.");
    }
    const html = await response.text();
    if (html.length > MAX_ARTICLE_RESPONSE_CHARACTERS) {
      throw new Error("Article response exceeds the configured size limit.");
    }
    return {
      requestedUrl: startUrl,
      finalUrl: currentUrl,
      html,
      fetchedAt: new Date().toISOString(),
    };
  }
  throw new Error("Article source exceeded the redirect limit.");
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLocaleLowerCase("en-US").startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

server.tool(
  "search_property_incident_articles",
  "Search Finnish and English news and official press releases for incident candidates linked to a property address. Results are discovery candidates only; verify a candidate with get_property_article_context before claiming an incident.",
  {
    address: z.string().min(3).max(200)
      .describe("Official or apartment/listing address, for example 'Karjalankatu 2 C 23'."),
    district: z.string().min(2).max(100).optional(),
    categories: z.array(z.enum(INCIDENT_CATEGORIES)).min(1).max(5)
      .default([...INCIDENT_CATEGORIES]),
    languages: z.array(z.enum(["fi", "en"])).min(1).max(2)
      .default(["fi", "en"]),
    includeSameStreet: z.boolean().default(false),
    includeNeighborhood: z.boolean().default(false),
    freshness: z.enum(["all", "day", "week", "month", "year"]).default("all"),
    limit: z.number().int().min(1).max(10).default(5),
  },
  async ({
    address,
    district,
    categories,
    languages,
    includeSameStreet,
    includeNeighborhood,
    freshness,
    limit,
  }) => {
    const normalizedAddress = normalizeArticleAddress(address);
    const provider = configuredProvider();
    const plans = buildArticleSearchPlans({
      address: normalizedAddress.normalizedAddress,
      district,
      categories: categories as IncidentCategory[],
      languages: languages as SearchLanguage[],
      includeSameStreet,
      includeNeighborhood,
      splitAddressCategories: provider === "brave",
    });
    const searches: Array<{
      plan: (typeof plans)[number];
      candidates: RawArticleCandidate[];
      fetchedAt: string | null;
      cacheHit: boolean;
      error: string | null;
    }> = [];

    const searchConcurrency = provider === "gdelt" ? 1 : 2;
    for (let index = 0; index < plans.length; index += searchConcurrency) {
      const batch = plans.slice(index, index + searchConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (plan) => {
          try {
            const response = await searchArticlePlan(
              provider,
              plan,
              Math.max(limit, 5),
              freshness as SearchFreshness
            );
            return { plan, ...response, error: null };
          } catch (error) {
            return {
              plan,
              candidates: [],
              fetchedAt: null,
              cacheHit: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );
      searches.push(...batchResults);
    }

    const candidatesByUrl = new Map<
      string,
      RawArticleCandidate & { discoveredByQueries: RawArticleCandidate["discoveredBy"][] }
    >();
    for (const search of searches) {
      for (const candidate of search.candidates) {
        const key = canonicalUrl(candidate.url);
        const existing = candidatesByUrl.get(key);
        if (existing) {
          existing.discoveredByQueries.push(candidate.discoveredBy);
        } else {
          candidatesByUrl.set(key, {
            ...candidate,
            url: key,
            discoveredByQueries: [candidate.discoveredBy],
          });
        }
      }
    }

    const relationRank: Record<string, number> = {
      exact_address: 5,
      inflected_address: 4,
      same_street: 3,
      neighborhood: 2,
      unverified: 1,
    };
    const classifiedCandidates = [...candidatesByUrl.values()]
      .map(({ discoveredBy: _singleDiscovery, ...candidate }) => {
        const metadataText = [candidate.title, candidate.description]
          .filter(Boolean)
          .join("\n");
        return {
          ...candidate,
          metadataMatch: classifyArticleText({
            text: metadataText,
            address: normalizedAddress.normalizedAddress,
            district,
          }),
          verificationStatus: "search_candidate_only" as const,
        };
      });

    const excludedCandidateCounts = {
      unverified_location: 0,
      same_street_not_requested: 0,
      neighborhood_not_requested: 0,
      no_requested_incident_evidence: 0,
    };
    const eligibleCandidates = classifiedCandidates.filter((candidate) => {
      const exclusionReason = candidateExclusionReason({
        relation: candidate.metadataMatch.relation,
        includeSameStreet,
        includeNeighborhood,
      });
      if (exclusionReason) {
        excludedCandidateCounts[exclusionReason] += 1;
        return false;
      }
      const hasRequestedIncidentEvidence = candidate.metadataMatch.incidentCategories.some(
        (category) => (categories as IncidentCategory[]).includes(category)
      );
      if (!hasRequestedIncidentEvidence) {
        excludedCandidateCounts.no_requested_incident_evidence += 1;
        return false;
      }
      return true;
    });

    const candidates = eligibleCandidates
      .sort((left, right) => {
        const relationDifference =
          relationRank[right.metadataMatch.relation] -
          relationRank[left.metadataMatch.relation];
        if (relationDifference !== 0) return relationDifference;
        return (
          (Date.parse(right.publishedDate ?? "") || 0) -
          (Date.parse(left.publishedDate ?? "") || 0)
        );
      })
      .slice(0, limit);

    return result({
      source: "Brave Search API or GDELT DOC API",
      provider: providerCoverage(provider, freshness as SearchFreshness),
      target: {
        ...normalizedAddress,
        district: district ?? null,
      },
      requestedCategories: categories,
      requestedLanguages: languages,
      returnedCandidates: candidates.length,
      uniqueCandidatesFound: candidatesByUrl.size,
      eligibleCandidatesFound: eligibleCandidates.length,
      excludedCandidates: {
        total: classifiedCandidates.length - eligibleCandidates.length,
        byReason: excludedCandidateCounts,
        detailsWithheld: true,
      },
      searchCoverage: {
        queriesAttempted: searches.length,
        queriesSucceeded: searches.filter((search) => !search.error).length,
        queriesFailed: searches.filter((search) => search.error).length,
        queries: searches.map((search) => ({
          id: search.plan.id,
          language: search.plan.language,
          scope: search.plan.scope,
          query: search.plan.query,
          candidatesFound: search.candidates.length,
          fetchedAt: search.fetchedAt,
          cacheHit: search.cacheHit,
          error: search.error,
        })),
      },
      candidates,
      interpretationRules: [
        "A search result is not a verified incident.",
        "Open a candidate with get_property_article_context before linking it to the target building.",
        "same_street and neighborhood results must never be described as incidents at the target address.",
        "Unverified-location candidates are withheld and must not be mentioned in the user-facing answer.",
        "Candidates without metadata evidence for a requested incident category are withheld.",
        "No search results must never be interpreted as proof that no incident occurred.",
      ],
    });
  }
);

server.tool(
  "get_property_article_context",
  "Fetch an allowlisted Finnish news or official press-release URL and extract a bounded text excerpt. When an address is supplied, deterministically verify address and incident-keyword evidence. Does not bypass paywalls.",
  {
    url: z.string().url().max(2000),
    address: z.string().min(3).max(200).optional(),
    district: z.string().min(2).max(100).optional(),
    maxCharacters: z.number().int().min(1000).max(12_000).default(8_000),
  },
  async ({ url, address, district, maxCharacters }) => {
    if (!isAllowedArticleUrl(url)) {
      throw new Error("The article URL is not on the configured Finnish source allowlist.");
    }
    const fetched = await fetchAllowedArticle(url);
    const articleText = htmlToText(fetched.html);
    const classification = address
      ? classifyArticleText({
          text: articleText,
          address,
          district,
        })
      : null;
    const excerpt = articleText.slice(0, maxCharacters);

    return result({
      source: "Original publisher page",
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl,
      fetchedAt: fetched.fetchedAt,
      title: articleTitle(fetched.html),
      publishedDate: articlePublishedDate(fetched.html),
      contentStatus:
        articleText.length < 300 ? "limited_or_paywalled" : "accessible_excerpt",
      extractedCharacters: articleText.length,
      excerptTruncated: articleText.length > excerpt.length,
      articleExcerpt: excerpt,
      targetAddress: address ?? null,
      verification: classification,
      interpretationRules: [
        "Only exact_address or inflected_address with incident evidence can support a target-building incident claim.",
        "If verification is null, the article was read without a target address and cannot establish a property link.",
        "Publication date is not necessarily the incident date; the agent must distinguish them.",
        "Severity and overall property risk require evidence-based synthesis and are not inferred by this tool.",
        "Absence of matching articles is not proof that no incident occurred.",
      ],
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Finnish property Articles MCP server started.");
}

main().catch((error) => {
  console.error("Finnish property Articles MCP failed:", error);
  process.exitCode = 1;
});
