export const INCIDENT_CATEGORIES = [
  "fire_rescue",
  "crime_police",
  "water_damage",
  "indoor_air_mold",
  "structural_risk",
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export type SearchLanguage = "fi" | "en";
export type RelationMatch =
  | "exact_address"
  | "inflected_address"
  | "same_street"
  | "neighborhood"
  | "unverified";

export const SOURCE_DOMAINS = [
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
] as const;

const KEYWORDS: Record<IncidentCategory, Record<SearchLanguage, string[]>> = {
  fire_rescue: {
    fi: ["tulipalo", "rakennuspalo", "huoneistopalo", "tuhopoltto", "evakuointi"],
    en: ["fire", "building fire", "apartment fire", "arson", "evacuated"],
  },
  crime_police: {
    fi: ["poliisioperaatio", "asuntomurto", "puukotus", "ampuminen", "huumausaine"],
    en: ["police operation", "burglary", "stabbing", "shooting", "drugs"],
  },
  water_damage: {
    fi: ["vesivahinko", "putkirikko", "vesivuoto"],
    en: ["water damage", "pipe leak", "water leak"],
  },
  indoor_air_mold: {
    fi: ["homeongelma", "sisäilmaongelma", "kosteusvaurio"],
    en: ["mold", "indoor air problem", "moisture damage"],
  },
  structural_risk: {
    fi: ["sortuma", "rakenteellinen vaurio", "sortumisvaara"],
    en: ["collapse", "structural damage", "collapse risk"],
  },
};

export interface NormalizedArticleAddress {
  rawAddress: string;
  normalizedAddress: string;
  street: string;
  houseNumber: string;
  discardedSuffix: string | null;
}

export interface ArticleSearchPlan {
  id: string;
  language: SearchLanguage;
  scope: "address" | "street" | "neighborhood";
  query: string;
}

export interface ArticleEvidence {
  evidenceType: "address" | "street" | "neighborhood" | "incident_keyword";
  matchedValue: string;
  excerpt: string;
}

export interface ArticleClassification {
  relation: RelationMatch;
  incidentCategories: IncidentCategory[];
  evidence: ArticleEvidence[];
  sufficientForIncidentClaim: boolean;
}

export type CandidateExclusionReason =
  | "unverified_location"
  | "same_street_not_requested"
  | "neighborhood_not_requested";

export function candidateExclusionReason(input: {
  relation: RelationMatch;
  includeSameStreet: boolean;
  includeNeighborhood: boolean;
}): CandidateExclusionReason | null {
  if (input.relation === "unverified") return "unverified_location";
  if (input.relation === "same_street" && !input.includeSameStreet) {
    return "same_street_not_requested";
  }
  if (input.relation === "neighborhood" && !input.includeNeighborhood) {
    return "neighborhood_not_requested";
  }
  return null;
}

function compactWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeArticleAddress(rawAddress: string): NormalizedArticleAddress {
  const raw = compactWhitespace(rawAddress);
  let cleaned = raw
    .replace(/,?\s*\b\d{5}\b(?:\s+(?:Helsinki|Helsingfors))?.*$/iu, "")
    .replace(/,?\s+(?:Helsinki|Helsingfors)\s*$/iu, "")
    .trim();
  const explicitUnit = cleaned.match(
    /\s+(?:as\.?|asunto|huoneisto|rappu|porras)\s*[\p{L}\p{N}-]*.*$/iu
  );
  if (explicitUnit?.index !== undefined) {
    cleaned = cleaned.slice(0, explicitUnit.index).trim();
  }

  const match = cleaned.match(
    /^([\p{L}\p{M}][\p{L}\p{M}'’.\-\s]*?)\s+(\d+(?:\s*[-–]\s*\d+)?(?:\s*[a-zåäö])?)(?=\s|,|$)/u
  );
  if (!match) {
    throw new Error(`Unable to parse a Finnish street address: ${rawAddress}`);
  }

  const street = match[1].trim();
  const houseNumber = match[2]
    .replace(/\s*[-–]\s*/g, "-")
    .replace(/\s+/g, " ");
  const normalizedAddress = `${street} ${houseNumber}`;
  const discardedSuffix = raw.slice(normalizedAddress.length).trim().replace(/^,\s*/, "");

  return {
    rawAddress: raw,
    normalizedAddress,
    street,
    houseNumber,
    discardedSuffix: discardedSuffix || null,
  };
}

function streetCaseForms(street: string): string[] {
  const lower = street.toLocaleLowerCase("fi");
  const prefix = (count: number) => street.slice(0, street.length - count);

  if (lower.endsWith("katu")) return [`${prefix(4)}kadulla`, `${prefix(4)}kadun`];
  if (lower.endsWith("tie")) return [`${prefix(3)}tiellä`, `${prefix(3)}tien`];
  if (lower.endsWith("kuja")) return [`${prefix(4)}kujalla`, `${prefix(4)}kujan`];
  if (lower.endsWith("raitio")) return [`${prefix(1)}olla`, `${prefix(1)}on`];
  if (lower.endsWith("polku")) return [`${prefix(5)}polulla`, `${prefix(5)}polun`];
  if (lower.endsWith("kaari")) return [`${prefix(5)}kaarella`, `${prefix(5)}kaaren`];
  return [];
}

export function inflectFinnishAddress(address: string): {
  addressVariants: string[];
  streetVariants: string[];
} {
  const normalized = normalizeArticleAddress(address);
  const streetVariants = [normalized.street, ...streetCaseForms(normalized.street)];
  return {
    addressVariants: [
      normalized.normalizedAddress,
      ...streetVariants.slice(1).map((street) => `${street} ${normalized.houseNumber}`),
    ],
    streetVariants,
  };
}

function quote(value: string): string {
  return `"${value.replace(/["“”]/g, "").trim()}"`;
}

function orBlock(values: string[]): string {
  return `(${values.map(quote).join(" OR ")})`;
}

export function keywordsFor(
  categories: IncidentCategory[],
  language: SearchLanguage
): string[] {
  return [...new Set(categories.flatMap((category) => KEYWORDS[category][language]))];
}

export function buildArticleSearchPlans(input: {
  address: string;
  district?: string | null;
  categories: IncidentCategory[];
  languages: SearchLanguage[];
  includeSameStreet: boolean;
  includeNeighborhood: boolean;
  splitAddressCategories?: boolean;
}): ArticleSearchPlan[] {
  const address = normalizeArticleAddress(input.address);
  const variants = inflectFinnishAddress(address.normalizedAddress);
  const plans: ArticleSearchPlan[] = [];

  const addressCategoryGroups = input.splitAddressCategories
    ? input.categories.map((category) => [category])
    : [input.categories];
  for (const categories of addressCategoryGroups) {
    for (const language of input.languages) {
      if (input.splitAddressCategories) {
        // Brave handles a short exact-address query far more reliably than a
        // large OR expression containing address inflections and every synonym.
        // The deterministic classifier still checks all category synonyms in
        // the returned metadata and article body.
        plans.push({
          id: `${language}_address_${categories[0]}`,
          language,
          scope: "address",
          query: `${quote(address.normalizedAddress)} ${
            keywordsFor(categories, language)[0]
          }`,
        });
        continue;
      }
      const addressTerms =
        language === "fi"
          ? variants.addressVariants.slice(0, 4)
          : [address.normalizedAddress];
      plans.push({
        id: `${language}_address_${categories.join("_")}`,
        language,
        scope: "address",
        query: `${orBlock(addressTerms)} ${orBlock(
          keywordsFor(categories, language)
        )}`,
      });
    }
  }

  for (const language of input.languages) {
    const keywords = keywordsFor(input.categories, language);
    if (input.includeSameStreet) {
      const streetTerms =
        language === "fi"
          ? variants.streetVariants.slice(0, 3)
          : [address.street];
      plans.push({
        id: `${language}_street`,
        language,
        scope: "street",
        query: `${orBlock(streetTerms)} ${orBlock(keywords)}`,
      });
    }

    if (input.includeNeighborhood && input.district?.trim()) {
      plans.push({
        id: `${language}_neighborhood`,
        language,
        scope: "neighborhood",
        query: `${quote(input.district.trim())} ${orBlock(keywords)}`,
      });
    }
  }

  return plans;
}

function comparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("fi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(text: string, match: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const index = comparable(normalizedText).indexOf(comparable(match));
  const start = Math.max(0, index - 100);
  const end = Math.min(normalizedText.length, index + match.length + 160);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${comparable(text)} `;
  const normalizedPhrase = comparable(phrase);
  return Boolean(normalizedPhrase) && normalizedText.includes(` ${normalizedPhrase} `);
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalizedText = comparable(text);
  const normalizedKeyword = comparable(keyword);
  if (normalizedKeyword.includes(" ")) return containsPhrase(text, keyword);
  const stemLength = normalizedKeyword.length >= 8 ? normalizedKeyword.length - 2 : normalizedKeyword.length;
  const stem = normalizedKeyword.slice(0, stemLength);
  return normalizedText.split(" ").some((token) => token === normalizedKeyword || token.startsWith(stem));
}

export function classifyArticleText(input: {
  text: string;
  address: string;
  district?: string | null;
}): ArticleClassification {
  const address = normalizeArticleAddress(input.address);
  const variants = inflectFinnishAddress(address.normalizedAddress);
  const evidence: ArticleEvidence[] = [];

  let relation: RelationMatch = "unverified";
  if (containsPhrase(input.text, address.normalizedAddress)) {
    relation = "exact_address";
    evidence.push({
      evidenceType: "address",
      matchedValue: address.normalizedAddress,
      excerpt: excerpt(input.text, address.normalizedAddress),
    });
  } else {
    const inflected = variants.addressVariants
      .slice(1)
      .find((variant) => containsPhrase(input.text, variant));
    if (inflected) {
      relation = "inflected_address";
      evidence.push({
        evidenceType: "address",
        matchedValue: inflected,
        excerpt: excerpt(input.text, inflected),
      });
    } else {
      const street = variants.streetVariants.find((variant) =>
        containsPhrase(input.text, variant)
      );
      if (street) {
        relation = "same_street";
        evidence.push({
          evidenceType: "street",
          matchedValue: street,
          excerpt: excerpt(input.text, street),
        });
      } else if (input.district?.trim() && containsPhrase(input.text, input.district)) {
        relation = "neighborhood";
        evidence.push({
          evidenceType: "neighborhood",
          matchedValue: input.district,
          excerpt: excerpt(input.text, input.district),
        });
      }
    }
  }

  const incidentCategories: IncidentCategory[] = [];
  for (const category of INCIDENT_CATEGORIES) {
    const matchedKeyword = ([...KEYWORDS[category].fi, ...KEYWORDS[category].en]).find(
      (keyword) => containsKeyword(input.text, keyword)
    );
    if (!matchedKeyword) continue;
    incidentCategories.push(category);
    evidence.push({
      evidenceType: "incident_keyword",
      matchedValue: matchedKeyword,
      excerpt: excerpt(input.text, matchedKeyword),
    });
  }

  return {
    relation,
    incidentCategories,
    evidence: evidence.slice(0, 10),
    sufficientForIncidentClaim:
      (relation === "exact_address" || relation === "inflected_address") &&
      incidentCategories.length > 0,
  };
}

export function isAllowedArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
    return SOURCE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}
