export interface NormalizedDecisionAddress {
  rawAddress: string;
  normalizedSearchAddress: string;
  discardedSuffix: string | null;
}

function cleanWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Converts a listing/apartment address into a parcel-level street address.
 *
 * This is a deterministic fallback for addresses that are not present in the
 * local parcel snapshot. ParcelIndex.resolveAddress should be preferred because
 * it can match the longest known official address before removing unit tokens.
 */
export function normalizeAddressForDecisions(
  rawAddress: string
): NormalizedDecisionAddress {
  const raw = cleanWhitespace(rawAddress);
  let cleaned = raw
    .replace(/,?\s*\b\d{5}\b(?:\s+(?:Helsinki|Helsingfors))?.*$/iu, "")
    .replace(/,?\s+Helsinki\s*$/iu, "")
    .replace(/,?\s+Helsingfors\s*$/iu, "")
    .trim();

  const explicitUnit = cleaned.match(
    /\s+(?:as\.?|asunto|huoneisto|rappu|porras)\s*[\p{L}\p{N}-]*.*$/iu
  );
  if (explicitUnit?.index !== undefined) {
    cleaned = cleaned.slice(0, explicitUnit.index).trim();
  }

  // A lowercase letter may be part of the official house number ("12 b").
  // Uppercase staircase letters and following apartment/building indices are
  // deliberately excluded ("14 C 23" and "14 1 C" -> "14").
  const rootMatch = cleaned.match(
    /^([\p{L}\p{M}][\p{L}\p{M}'’.\-\s]*?)\s+(\d+(?:\s*[-–]\s*\d+)?(?:\s*[a-zåäö])?)(?=\s|,|$)/u
  );
  const normalizedSearchAddress = rootMatch
    ? `${rootMatch[1].trim()} ${rootMatch[2]
        .replace(/\s*[-–]\s*/g, "-")
        .replace(/\s+/g, " ")}`
    : cleaned;
  const discarded = raw.slice(normalizedSearchAddress.length).trim();

  return {
    rawAddress: raw,
    normalizedSearchAddress,
    discardedSuffix: discarded || null,
  };
}

export function normalizeAddressKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("fi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
