import { isAllowedArticleUrl, type ArticleSearchPlan } from "./article-intelligence.js";

export type ArticleProvider = "brave" | "gdelt";
export type SearchFreshness = "all" | "day" | "week" | "month" | "year";

export interface RawArticleCandidate {
  title: string | null;
  url: string;
  description: string | null;
  publishedDate: string | null;
  sourceDomain: string;
  sourceLanguage: string | null;
  provider: ArticleProvider;
  discoveredBy: {
    planId: string;
    language: ArticleSearchPlan["language"];
    scope: ArticleSearchPlan["scope"];
    query: string;
  };
}

interface CacheEntry {
  expiresAt: number;
  candidates: RawArticleCandidate[];
  fetchedAt: string;
}

const BRAVE_BASE_URL =
  process.env.BRAVE_SEARCH_BASE_URL?.trim() ||
  "https://api.search.brave.com/res/v1/web/search";
const GDELT_BASE_URL =
  process.env.GDELT_DOC_API_URL?.trim() ||
  "https://api.gdeltproject.org/api/v2/doc/doc";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_RESPONSE_CHARACTERS = 2_000_000;
const GDELT_MIN_INTERVAL_MS = 5_500;
const cache = new Map<string, CacheEntry>();
let gdeltQueue: Promise<void> = Promise.resolve();
let nextGdeltRequestAt = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inGdeltRequestSlot<T>(action: () => Promise<T>): Promise<T> {
  let resolveSlot!: () => void;
  const previous = gdeltQueue;
  gdeltQueue = new Promise<void>((resolve) => {
    resolveSlot = resolve;
  });
  await previous;
  try {
    const waitMilliseconds = Math.max(0, nextGdeltRequestAt - Date.now());
    if (waitMilliseconds > 0) await delay(waitMilliseconds);
    nextGdeltRequestAt = Date.now() + GDELT_MIN_INTERVAL_MS;
    return await action();
  } finally {
    resolveSlot();
  }
}

function sourceDomain(value: string): string {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return "";
  }
}

function requestCacheKey(url: URL, headers: Record<string, string>): string {
  return `${url.toString()}\n${Object.keys(headers).sort().join(",")}`;
}

function storeCache(key: string, entry: CacheEntry): void {
  const now = Date.now();
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(cachedKey);
  }
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  if (/^\d{14}$/.test(text)) {
    const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`;
    return Number.isNaN(Date.parse(iso)) ? text : iso;
  }
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? text : new Date(timestamp).toISOString();
}

async function getJson(
  url: URL,
  headers: Record<string, string> = {},
  retryOnRateLimit = false
): Promise<{ data: Record<string, unknown>; fetchedAt: string; cacheHit: boolean }> {
  const key = requestCacheKey(url, headers);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      data: { __cachedCandidates: cached.candidates },
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && retryOnRateLimit && attempt === 0) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryDelay = Number.isFinite(retryAfterSeconds)
        ? Math.min(Math.max(retryAfterSeconds * 1000, GDELT_MIN_INTERVAL_MS), 30_000)
        : GDELT_MIN_INTERVAL_MS;
      await response.text();
      await delay(retryDelay);
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`Article search returned HTTP ${response.status}: ${detail}`);
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARACTERS) {
      throw new Error("Article search response exceeded the configured size limit.");
    }
    return {
      data: JSON.parse(raw) as Record<string, unknown>,
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
    };
  }
  throw new Error("Article search rate-limit retry was exhausted.");
}

function braveFreshness(value: SearchFreshness): string | null {
  return ({ day: "pd", week: "pw", month: "pm", year: "py", all: null } as const)[value];
}

function gdeltTimespan(value: SearchFreshness): string | null {
  return ({ day: "1d", week: "1w", month: "1m", year: "3m", all: null } as const)[value];
}

function braveQuery(plan: ArticleSearchPlan): string {
  // Brave can rank exact matches much worse when many site: clauses are OR-ed
  // together. Source safety is enforced after discovery by isAllowedArticleUrl.
  return plan.query;
}

function searchDiscovery(plan: ArticleSearchPlan) {
  return {
    planId: plan.id,
    language: plan.language,
    scope: plan.scope,
    query: plan.query,
  };
}

async function searchBrave(
  plan: ArticleSearchPlan,
  limit: number,
  freshness: SearchFreshness
): Promise<{ candidates: RawArticleCandidate[]; fetchedAt: string; cacheHit: boolean }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is required when ARTICLE_SEARCH_PROVIDER=brave.");
  }

  const url = new URL(BRAVE_BASE_URL);
  url.searchParams.set("q", braveQuery(plan));
  url.searchParams.set("count", String(Math.min(Math.max(limit * 2, 5), 20)));
  url.searchParams.set("country", "fi");
  url.searchParams.set("search_lang", plan.language);
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("spellcheck", "0");
  const freshnessValue = braveFreshness(freshness);
  if (freshnessValue) url.searchParams.set("freshness", freshnessValue);

  const response = await getJson(url, { "X-Subscription-Token": apiKey });
  const cached = response.data.__cachedCandidates;
  if (Array.isArray(cached)) {
    return {
      candidates: cached as RawArticleCandidate[],
      fetchedAt: response.fetchedAt,
      cacheHit: true,
    };
  }

  const web = response.data.web as { results?: unknown[] } | undefined;
  const rootResults = response.data.results;
  const items = web?.results ?? (Array.isArray(rootResults) ? rootResults : []);
  const candidates: RawArticleCandidate[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown>;
    const articleUrl = stringValue(record.url);
    if (!articleUrl || !isAllowedArticleUrl(articleUrl)) continue;
    candidates.push({
        title: stringValue(record.title),
        url: articleUrl,
        description: stringValue(record.description),
        publishedDate: normalizeDate(record.page_age),
        sourceDomain: sourceDomain(articleUrl),
        sourceLanguage: stringValue(record.language) ?? plan.language,
        provider: "brave" as const,
        discoveredBy: searchDiscovery(plan),
    });
    if (candidates.length >= limit) break;
  }
  storeCache(requestCacheKey(url, { "X-Subscription-Token": apiKey }), {
    expiresAt: Date.now() + CACHE_TTL_MS,
    candidates,
    fetchedAt: response.fetchedAt,
  });
  return { candidates, fetchedAt: response.fetchedAt, cacheHit: false };
}

async function searchGdelt(
  plan: ArticleSearchPlan,
  limit: number,
  freshness: SearchFreshness
): Promise<{ candidates: RawArticleCandidate[]; fetchedAt: string; cacheHit: boolean }> {
  const url = new URL(GDELT_BASE_URL);
  url.searchParams.set("query", `${plan.query} sourcecountry:finland`);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("maxrecords", String(Math.min(Math.max(limit * 5, 10), 75)));
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  const timespan = gdeltTimespan(freshness);
  if (timespan) url.searchParams.set("timespan", timespan);

  const response = await inGdeltRequestSlot(() => getJson(url, {}, true));
  const cached = response.data.__cachedCandidates;
  if (Array.isArray(cached)) {
    return {
      candidates: cached as RawArticleCandidate[],
      fetchedAt: response.fetchedAt,
      cacheHit: true,
    };
  }

  const articles = Array.isArray(response.data.articles) ? response.data.articles : [];
  const candidates: RawArticleCandidate[] = [];
  for (const item of articles) {
    const record = item as Record<string, unknown>;
    const articleUrl = stringValue(record.url);
    if (!articleUrl || !isAllowedArticleUrl(articleUrl)) continue;
    candidates.push({
        title: stringValue(record.title),
        url: articleUrl,
        description: null,
        publishedDate: normalizeDate(record.seendate),
        sourceDomain: sourceDomain(articleUrl),
        sourceLanguage: stringValue(record.language),
        provider: "gdelt" as const,
        discoveredBy: searchDiscovery(plan),
    });
    if (candidates.length >= limit) break;
  }
  storeCache(requestCacheKey(url, {}), {
    expiresAt: Date.now() + CACHE_TTL_MS,
    candidates,
    fetchedAt: response.fetchedAt,
  });
  return { candidates, fetchedAt: response.fetchedAt, cacheHit: false };
}

export function configuredProvider(): ArticleProvider {
  const configured = process.env.ARTICLE_SEARCH_PROVIDER?.trim().toLocaleLowerCase("en-US");
  if (configured === "brave" || configured === "gdelt") return configured;
  return process.env.BRAVE_SEARCH_API_KEY?.trim() ? "brave" : "gdelt";
}

export async function searchArticlePlan(
  provider: ArticleProvider,
  plan: ArticleSearchPlan,
  limit: number,
  freshness: SearchFreshness
) {
  return provider === "brave"
    ? searchBrave(plan, limit, freshness)
    : searchGdelt(plan, limit, freshness);
}

export function providerCoverage(provider: ArticleProvider, freshness: SearchFreshness) {
  return provider === "brave"
    ? {
        provider,
        requestedFreshness: freshness,
        historicalCoverage: freshness === "all" ? "search-index-dependent" : freshness,
        limitation: "Search results are discovery candidates and do not prove an incident until article content is verified.",
      }
    : {
        provider,
        requestedFreshness: freshness,
        historicalCoverage: freshness === "day" || freshness === "week" || freshness === "month" ? freshness : "up_to_3_months",
        limitation: "GDELT fallback has recent-news coverage only and may miss local or historical incidents. No result is not evidence that no incident occurred.",
      };
}
