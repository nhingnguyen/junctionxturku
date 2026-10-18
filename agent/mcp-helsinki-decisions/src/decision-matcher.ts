import {
  extractParcelIdentifiers,
  normalizeParcelIdentifier,
} from "./parcel-index.js";

export type ParcelDecisionMatchType =
  | "exact_parcel_and_address"
  | "exact_parcel_id_only"
  | "address_match_only"
  | "broader_block_context"
  | "unclassified"
  | "conflict";

export type DecisionEvidenceType =
  | "parcel_id"
  | "address"
  | "block";

export interface DecisionTextField {
  field: "subject" | "issue_subject" | "decision_content";
  text: string;
}

export interface DecisionMatchEvidence {
  field: DecisionTextField["field"];
  evidenceType: DecisionEvidenceType;
  matchedValue: string;
  excerpt: string;
}

export interface ParcelDecisionMatch {
  matchType: ParcelDecisionMatchType;
  verified: boolean;
  score: number;
  selectedParcelIdentifier: string;
  selectedAddresses: string[];
  parcelIdentifiersFound: Array<{ raw: string; normalized: string }>;
  conflictingParcelIdentifiers: Array<{ raw: string; normalized: string }>;
  evidence: DecisionMatchEvidence[];
}

interface ClassifyParcelDecisionInput {
  selectedParcelIdentifier: string;
  selectedAddresses?: string[];
  fields: DecisionTextField[];
}

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("fi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueNonEmpty(values: string[]): string[] {
  const unique = new Map<string, string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeComparable(trimmed);
    if (key && !unique.has(key)) unique.set(key, trimmed);
  }

  return [...unique.values()];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseMatch(
  text: string,
  phrase: string,
  allowInflectedLastToken: boolean
): RegExpMatchArray | null {
  const tokens = normalizeComparable(phrase).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  const patternTokens = tokens.map((token, index) => {
    if (
      allowInflectedLastToken &&
      index === tokens.length - 1 &&
      token.length >= 5
    ) {
      const stemLength = token.length >= 8 ? token.length - 2 : token.length - 1;
      return `${escapeRegex(token.slice(0, stemLength))}\\p{L}{1,14}`;
    }
    return escapeRegex(token);
  });
  const body = patternTokens.join("[\\s\\p{P}\\p{S}]*");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
    "iu"
  );
  return text.match(pattern);
}

function excerptAround(text: string, start: number, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const safeStart = Math.max(0, Math.min(start, compact.length));
  const from = Math.max(0, safeStart - 110);
  const to = Math.min(compact.length, safeStart + length + 170);
  return `${from > 0 ? "…" : ""}${compact.slice(from, to)}${to < compact.length ? "…" : ""}`;
}

function phraseEvidence(
  field: DecisionTextField,
  phrase: string,
  evidenceType: "address"
): DecisionMatchEvidence | null {
  const compact = field.text.replace(/\s+/g, " ").trim();
  const match = phraseMatch(compact, phrase, false);
  if (!match) return null;

  return {
    field: field.field,
    evidenceType,
    matchedValue: match[0],
    excerpt: excerptAround(compact, match.index ?? 0, match[0].length),
  };
}

function blockEvidence(
  field: DecisionTextField,
  normalizedParcelIdentifier: string
): DecisionMatchEvidence | null {
  const blockNumber = String(Number(normalizedParcelIdentifier.slice(6, 10)));
  const compact = field.text.replace(/\s+/g, " ").trim();
  const match = compact.match(
    new RegExp(
      `(?<![\\p{L}\\p{N}])korttel\\p{L}*\\s+(?:nro\\s*)?0*${escapeRegex(blockNumber)}(?!\\p{N})`,
      "iu"
    )
  );
  if (!match) return null;

  return {
    field: field.field,
    evidenceType: "block",
    matchedValue: match[0],
    excerpt: excerptAround(compact, match.index ?? 0, match[0].length),
  };
}

function addEvidence(
  target: DecisionMatchEvidence[],
  evidence: DecisionMatchEvidence
): void {
  const key = [
    evidence.field,
    evidence.evidenceType,
    normalizeComparable(evidence.matchedValue),
  ].join(":");

  if (
    !target.some(
      (item) =>
        [item.field, item.evidenceType, normalizeComparable(item.matchedValue)].join(":") === key
    )
  ) {
    target.push(evidence);
  }
}

export function classifyParcelDecision(
  input: ClassifyParcelDecisionInput
): ParcelDecisionMatch {
  const selectedParcelIdentifier = normalizeParcelIdentifier(
    input.selectedParcelIdentifier
  );
  if (!selectedParcelIdentifier) {
    throw new Error(`Invalid Finnish property identifier: ${input.selectedParcelIdentifier}`);
  }

  const selectedAddresses = uniqueNonEmpty(input.selectedAddresses ?? []);
  const evidence: DecisionMatchEvidence[] = [];
  const parcelIdentifiers = new Map<string, { raw: string; normalized: string }>();

  for (const field of input.fields) {
    for (const reference of extractParcelIdentifiers(field.text)) {
      parcelIdentifiers.set(reference.normalized, reference);
      if (reference.normalized !== selectedParcelIdentifier) continue;

      const compact = field.text.replace(/\s+/g, " ").trim();
      const index = compact.indexOf(reference.raw);
      addEvidence(evidence, {
        field: field.field,
        evidenceType: "parcel_id",
        matchedValue: reference.raw,
        excerpt: excerptAround(
          compact,
          index >= 0 ? index : 0,
          reference.raw.length
        ),
      });
    }

    for (const address of selectedAddresses) {
      const match = phraseEvidence(field, address, "address");
      if (match) addEvidence(evidence, match);
    }

    const blockMatch = blockEvidence(field, selectedParcelIdentifier);
    if (blockMatch) addEvidence(evidence, blockMatch);
  }

  const parcelIdentifiersFound = [...parcelIdentifiers.values()];
  const conflictingParcelIdentifiers = parcelIdentifiersFound.filter(
    (reference) => reference.normalized !== selectedParcelIdentifier
  );
  const hasParcelMatch = evidence.some(
    (item) => item.evidenceType === "parcel_id"
  );
  const hasAddressMatch = evidence.some(
    (item) => item.evidenceType === "address"
  );
  const selectedBlock = selectedParcelIdentifier.slice(0, 10);
  const hasBlockMatch =
    evidence.some((item) => item.evidenceType === "block") ||
    conflictingParcelIdentifiers.some((reference) =>
      reference.normalized.startsWith(selectedBlock)
    );

  let matchType: ParcelDecisionMatchType;
  let verified = false;
  let score = 0;

  if (hasParcelMatch && hasAddressMatch) {
    matchType = "exact_parcel_and_address";
    verified = true;
    score = 100;
  } else if (hasParcelMatch) {
    matchType = "exact_parcel_id_only";
    verified = true;
    score = 95;
  } else if (hasAddressMatch && conflictingParcelIdentifiers.length > 0) {
    matchType = "conflict";
    score = 5;
  } else if (hasAddressMatch) {
    matchType = "address_match_only";
    score = 80;
  } else if (hasBlockMatch) {
    matchType = "broader_block_context";
    score = 40;
  } else {
    matchType = "unclassified";
  }

  return {
    matchType,
    verified,
    score,
    selectedParcelIdentifier,
    selectedAddresses,
    parcelIdentifiersFound,
    conflictingParcelIdentifiers,
    evidence: evidence.slice(0, 12),
  };
}
