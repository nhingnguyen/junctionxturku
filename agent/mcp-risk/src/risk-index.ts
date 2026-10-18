import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type RiskCadence = "static" | "periodic" | "live";

export interface RiskFactor {
  data: Record<string, unknown>;
  scope: Record<string, unknown>;
  source: { refs: string[] };
  as_of: string | null;
  method: string;
  freshness: Record<string, unknown>;
  aggregation?: Record<string, unknown>;
  legacy_data?: Record<string, unknown>;
  legacy_data_status?: string;
}

export interface RiskParcel {
  kiinteistotunnus: string;
  text_format: string;
  official_addresses: string[];
  postal_code: string;
  coordinates_wgs84: [number, number];
  total_buildings: number;
  total_floor_area_sqm: number;
  risk_profile: Record<RiskCadence, Record<string, RiskFactor>>;
}

interface RiskDataset {
  schema_version: string;
  generated_at: string;
  metadata: Record<string, unknown>;
  source_catalog: Record<string, unknown>;
  parcels: Record<string, RiskParcel>;
}

export interface AddressResolution {
  rawAddress: string;
  normalizedSearchAddress: string;
  officialAddress: string | null;
  discardedSuffix: string | null;
  resolutionMethod:
    | "exact_official_address"
    | "official_address_prefix"
    | "parsed_fallback";
  parcels: RiskParcel[];
}

export type RiskParcelResolution =
  | {
      status: "resolved";
      matchedBy: "property_identifier" | "address" | "property_identifier_and_address";
      parcel: RiskParcel;
      addressResolution: AddressResolution | null;
    }
  | {
      status:
        | "not_found_in_local_snapshot"
        | "ambiguous_address"
        | "parcel_address_conflict"
        | "parcel_address_unverified"
        | "invalid_property_identifier";
      parcels: RiskParcel[];
      addressResolution: AddressResolution | null;
      normalizedPropertyIdentifier: string | null;
    };

const DEFAULT_DATA_PATH = fileURLToPath(
  new URL("../../parcels_with_normalized_risks.json", import.meta.url)
);

function cleanWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeAddressKey(value: string): string {
  return cleanWhitespace(value)
    .toLocaleLowerCase("fi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function fallbackStreetAddress(value: string): string {
  let cleaned = cleanWhitespace(value)
    .replace(/,?\s*\b\d{5}\b(?:\s+(?:Helsinki|Helsingfors))?.*$/iu, "")
    .replace(/,?\s+(?:Helsinki|Helsingfors)\s*$/iu, "")
    .trim();
  const explicitUnit = cleaned.match(
    /\s+(?:as\.?|asunto|huoneisto|rappu|porras)\s*[\p{L}\p{N}-]*.*$/iu
  );
  if (explicitUnit?.index !== undefined) {
    cleaned = cleaned.slice(0, explicitUnit.index).trim();
  }
  return cleaned;
}

export function normalizePropertyIdentifier(value: string): string | null {
  const compact = cleanWhitespace(value)
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s/gu, "");
  if (/^\d{14}$/u.test(compact)) return compact;

  const parts = compact.split("-");
  if (
    parts.length !== 4 ||
    !parts.every((part) => /^\d+$/u.test(part)) ||
    parts[0].length > 3 ||
    parts[1].length > 3 ||
    parts[2].length > 4 ||
    parts[3].length > 4
  ) {
    return null;
  }
  return [
    parts[0].padStart(3, "0"),
    parts[1].padStart(3, "0"),
    parts[2].padStart(4, "0"),
    parts[3].padStart(4, "0"),
  ].join("");
}

function uniqueParcels(parcels: RiskParcel[]): RiskParcel[] {
  return [...new Map(parcels.map((parcel) => [parcel.kiinteistotunnus, parcel])).values()];
}

export class RiskIndex {
  readonly dataPath: string;
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly metadata: Record<string, unknown>;
  readonly sourceCatalog: Record<string, unknown>;
  private readonly parcelsById = new Map<string, RiskParcel>();
  private readonly parcelsByAddress = new Map<string, RiskParcel[]>();

  constructor(dataPath = process.env.RISK_DATA_PATH?.trim() || DEFAULT_DATA_PATH) {
    this.dataPath = dataPath;
    const dataset = JSON.parse(readFileSync(dataPath, "utf8")) as RiskDataset;
    this.schemaVersion = dataset.schema_version;
    this.generatedAt = dataset.generated_at;
    this.metadata = dataset.metadata;
    this.sourceCatalog = dataset.source_catalog;

    for (const [parcelId, parcel] of Object.entries(dataset.parcels)) {
      this.parcelsById.set(parcelId, parcel);
      for (const address of parcel.official_addresses) {
        const key = normalizeAddressKey(address);
        const matches = this.parcelsByAddress.get(key) ?? [];
        matches.push(parcel);
        this.parcelsByAddress.set(key, matches);
      }
    }
  }

  findByIdentifier(value: string): RiskParcel | null {
    const normalized = normalizePropertyIdentifier(value);
    return normalized ? this.parcelsById.get(normalized) ?? null : null;
  }

  resolveAddress(value: string): AddressResolution {
    const rawAddress = cleanWhitespace(value);
    const inputKey = normalizeAddressKey(rawAddress);
    const exact = this.parcelsByAddress.get(inputKey);
    if (exact) {
      const officialAddress = exact
        .flatMap((parcel) => parcel.official_addresses)
        .find((address) => normalizeAddressKey(address) === inputKey) ?? rawAddress;
      return {
        rawAddress,
        normalizedSearchAddress: officialAddress,
        officialAddress,
        discardedSuffix: null,
        resolutionMethod: "exact_official_address",
        parcels: uniqueParcels(exact),
      };
    }

    const prefixes = [...this.parcelsByAddress.keys()]
      .filter((key) => inputKey.startsWith(`${key} `))
      .sort((left, right) => right.length - left.length);
    const longestKey = prefixes[0];
    if (longestKey) {
      const parcels = uniqueParcels(this.parcelsByAddress.get(longestKey) ?? []);
      const officialAddress = parcels
        .flatMap((parcel) => parcel.official_addresses)
        .find((address) => normalizeAddressKey(address) === longestKey) ?? null;
      if (officialAddress) {
        return {
          rawAddress,
          normalizedSearchAddress: officialAddress,
          officialAddress,
          discardedSuffix:
            rawAddress.slice(officialAddress.length).trim().replace(/^,\s*/u, "") ||
            null,
          resolutionMethod: "official_address_prefix",
          parcels,
        };
      }
    }

    const fallback = fallbackStreetAddress(rawAddress);
    const fallbackParcels = uniqueParcels(
      this.parcelsByAddress.get(normalizeAddressKey(fallback)) ?? []
    );
    return {
      rawAddress,
      normalizedSearchAddress: fallback,
      officialAddress:
        fallbackParcels
          .flatMap((parcel) => parcel.official_addresses)
          .find((address) => normalizeAddressKey(address) === normalizeAddressKey(fallback)) ??
        null,
      discardedSuffix:
        fallback.length < rawAddress.length
          ? rawAddress.slice(fallback.length).trim().replace(/^,\s*/u, "") || null
          : null,
      resolutionMethod: "parsed_fallback",
      parcels: fallbackParcels,
    };
  }

  resolve(propertyIdentifier?: string, address?: string): RiskParcelResolution {
    const addressResolution = address ? this.resolveAddress(address) : null;
    const normalizedPropertyIdentifier = propertyIdentifier
      ? normalizePropertyIdentifier(propertyIdentifier)
      : null;

    if (propertyIdentifier && !normalizedPropertyIdentifier) {
      return {
        status: "invalid_property_identifier",
        parcels: [],
        addressResolution,
        normalizedPropertyIdentifier: null,
      };
    }

    if (normalizedPropertyIdentifier) {
      const parcel = this.parcelsById.get(normalizedPropertyIdentifier);
      if (!parcel) {
        return {
          status: "not_found_in_local_snapshot",
          parcels: [],
          addressResolution,
          normalizedPropertyIdentifier,
        };
      }
      if (address && addressResolution?.parcels.length === 0) {
        return {
          status: "parcel_address_unverified",
          parcels: [parcel],
          addressResolution,
          normalizedPropertyIdentifier,
        };
      }
      if (
        addressResolution &&
        addressResolution.parcels.length > 0 &&
        !addressResolution.parcels.some(
          (candidate) => candidate.kiinteistotunnus === normalizedPropertyIdentifier
        )
      ) {
        return {
          status: "parcel_address_conflict",
          parcels: [parcel, ...addressResolution.parcels],
          addressResolution,
          normalizedPropertyIdentifier,
        };
      }
      return {
        status: "resolved",
        matchedBy: address
          ? "property_identifier_and_address"
          : "property_identifier",
        parcel,
        addressResolution,
      };
    }

    if ((addressResolution?.parcels.length ?? 0) === 1) {
      return {
        status: "resolved",
        matchedBy: "address",
        parcel: addressResolution!.parcels[0],
        addressResolution,
      };
    }
    return {
      status:
        (addressResolution?.parcels.length ?? 0) > 1
          ? "ambiguous_address"
          : "not_found_in_local_snapshot",
      parcels: addressResolution?.parcels ?? [],
      addressResolution,
      normalizedPropertyIdentifier: null,
    };
  }
}

export function compactRiskParcel(parcel: RiskParcel) {
  return {
    propertyIdentifier: parcel.kiinteistotunnus,
    textFormat: parcel.text_format,
    officialAddresses: parcel.official_addresses,
    postalCode: parcel.postal_code,
    coordinatesWgs84: parcel.coordinates_wgs84,
    totalBuildings: parcel.total_buildings,
    totalFloorAreaSqm: parcel.total_floor_area_sqm,
  };
}

export function selectRiskProfile(
  parcel: RiskParcel,
  sections: RiskCadence[],
  includeLegacyEvidence: boolean
): Partial<Record<RiskCadence, Record<string, RiskFactor>>> {
  return Object.fromEntries(
    sections.map((section) => [
      section,
      Object.fromEntries(
        Object.entries(parcel.risk_profile[section]).map(([name, factor]) => {
          if (includeLegacyEvidence) return [name, factor];
          const { legacy_data: _legacyData, legacy_data_status: _legacyStatus, ...safe } =
            factor;
          return [name, safe];
        })
      ),
    ])
  );
}
