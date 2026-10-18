import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeAddressForDecisions,
  normalizeAddressKey,
  type NormalizedDecisionAddress,
} from "./address-normalizer.js";

export interface LocalBuilding {
  building_key: string;
  permanent_building_id: string | null;
  completion_year: string | null;
  number_of_storeys: number | null;
  floor_area_sqm: number | null;
  gross_floor_area_sqm: number | null;
  main_purpose_code: string | null;
  coordinates: [number, number] | null;
}

export interface LocalParcel {
  kiinteistotunnus: string;
  text_format: string;
  municipality_code: number;
  district_code: number;
  block_code: number;
  plot_code: number;
  addresses: string[];
  postal_codes: string[];
  total_floor_area_sqm: number;
  total_buildings: number;
  representative_coordinates: [number, number] | null;
  buildings: LocalBuilding[];
}

interface ParcelDataset {
  metadata: {
    bbox_wgs84: [number, number, number, number];
    total_parcels: number;
    total_buildings: number;
    source: string;
  };
  parcels: LocalParcel[];
}

export interface ParcelMatch {
  matchMethod: "parcel_identifier" | "address";
  matchedValue: string;
  parcel: LocalParcel;
}

export interface AddressResolution extends NormalizedDecisionAddress {
  officialAddress: string | null;
  resolutionMethod:
    | "exact_official_address"
    | "official_address_prefix"
    | "parsed_fallback";
  parcels: LocalParcel[];
}

const DEFAULT_DATA_PATH = fileURLToPath(
  new URL("../../bbox_parcels.json", import.meta.url)
);

export function normalizeParcelIdentifier(value: string): string | null {
  const compact = value
    .trim()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s/g, "");

  if (/^\d{14}$/.test(compact)) return compact;

  const parts = compact.split("-");
  if (
    parts.length !== 4 ||
    !parts.every((part) => /^\d+$/.test(part)) ||
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

export function formatParcelIdentifier(value: string): string | null {
  const normalized = normalizeParcelIdentifier(value);
  if (!normalized) return null;

  return [
    normalized.slice(0, 3),
    normalized.slice(3, 6),
    normalized.slice(6, 10),
    normalized.slice(10, 14),
  ]
    .map((part) => String(Number(part)))
    .join("-");
}

export function extractParcelIdentifiers(text: string): Array<{
  raw: string;
  normalized: string;
}> {
  const candidates = [
    ...(text.match(/\b\d{2,3}\s*[-‐‑‒–—−]\s*\d{1,3}\s*[-‐‑‒–—−]\s*\d{1,4}\s*[-‐‑‒–—−]\s*\d{1,4}\b/g) ?? []),
    ...(text.match(/\b\d{14}\b/g) ?? []),
  ];
  const unique = new Map<string, string>();

  for (const raw of candidates) {
    const normalized = normalizeParcelIdentifier(raw);
    if (normalized && !unique.has(normalized)) unique.set(normalized, raw);
  }

  return [...unique.entries()].map(([normalized, raw]) => ({ raw, normalized }));
}

export class ParcelIndex {
  readonly metadata: ParcelDataset["metadata"];
  readonly dataPath: string;
  private readonly parcelsById = new Map<string, LocalParcel>();
  private readonly parcelsByAddress = new Map<string, LocalParcel[]>();

  constructor(dataPath = process.env.PARCEL_DATA_PATH?.trim() || DEFAULT_DATA_PATH) {
    this.dataPath = dataPath;
    const dataset = JSON.parse(readFileSync(dataPath, "utf8")) as ParcelDataset;
    this.metadata = dataset.metadata;

    for (const parcel of dataset.parcels) {
      this.parcelsById.set(parcel.kiinteistotunnus, parcel);

      for (const address of parcel.addresses) {
        const key = normalizeAddressKey(address);
        const matches = this.parcelsByAddress.get(key) ?? [];
        matches.push(parcel);
        this.parcelsByAddress.set(key, matches);
      }
    }
  }

  findByIdentifier(value: string): LocalParcel | null {
    const normalized = normalizeParcelIdentifier(value);
    return normalized ? this.parcelsById.get(normalized) ?? null : null;
  }

  findByAddress(value: string): LocalParcel[] {
    return this.parcelsByAddress.get(normalizeAddressKey(value)) ?? [];
  }

  resolveAddress(value: string): AddressResolution {
    const fallback = normalizeAddressForDecisions(value);
    const inputKey = normalizeAddressKey(value);
    const exact = this.parcelsByAddress.get(inputKey);
    if (exact) {
      const officialAddress = exact
        .flatMap((parcel) => parcel.addresses)
        .find((address) => normalizeAddressKey(address) === inputKey) ?? value.trim();
      return {
        ...fallback,
        normalizedSearchAddress: officialAddress,
        discardedSuffix: null,
        officialAddress,
        resolutionMethod: "exact_official_address",
        parcels: exact,
      };
    }

    const prefixes = [...this.parcelsByAddress.keys()]
      .filter((addressKey) => inputKey.startsWith(`${addressKey} `))
      .sort((left, right) => right.length - left.length);
    const longestKey = prefixes[0];
    if (longestKey) {
      const parcels = this.parcelsByAddress.get(longestKey) ?? [];
      const officialAddress = parcels
        .flatMap((parcel) => parcel.addresses)
        .find((address) => normalizeAddressKey(address) === longestKey) ?? null;
      if (officialAddress) {
        const officialEnd = value
          .toLocaleLowerCase("fi")
          .indexOf(officialAddress.toLocaleLowerCase("fi")) + officialAddress.length;
        return {
          rawAddress: fallback.rawAddress,
          normalizedSearchAddress: officialAddress,
          discardedSuffix:
            officialEnd >= officialAddress.length
              ? value.slice(officialEnd).trim().replace(/^,\s*/, "") || null
              : fallback.discardedSuffix,
          officialAddress,
          resolutionMethod: "official_address_prefix",
          parcels,
        };
      }
    }

    return {
      ...fallback,
      officialAddress: null,
      resolutionMethod: "parsed_fallback",
      parcels: this.findByAddress(fallback.normalizedSearchAddress),
    };
  }

  findMatchesInText(text: string, limit = 10): ParcelMatch[] {
    const matches: ParcelMatch[] = [];
    const matchedParcels = new Set<string>();

    for (const identifier of extractParcelIdentifiers(text)) {
      const parcel = this.parcelsById.get(identifier.normalized);
      if (!parcel) continue;
      matches.push({
        matchMethod: "parcel_identifier",
        matchedValue: identifier.raw,
        parcel,
      });
      matchedParcels.add(parcel.kiinteistotunnus);
      if (matches.length >= limit) return matches;
    }

    const normalizedText = ` ${normalizeAddressKey(text)} `;
    for (const [address, parcels] of this.parcelsByAddress) {
      if (!normalizedText.includes(` ${address} `)) continue;

      for (const parcel of parcels) {
        if (matchedParcels.has(parcel.kiinteistotunnus)) continue;
        matches.push({ matchMethod: "address", matchedValue: address, parcel });
        matchedParcels.add(parcel.kiinteistotunnus);
        if (matches.length >= limit) return matches;
      }
    }

    return matches;
  }
}

export function compactParcel(parcel: LocalParcel) {
  return {
    propertyIdentifier: parcel.kiinteistotunnus,
    textFormat: parcel.text_format,
    addresses: parcel.addresses,
    postalCodes: parcel.postal_codes,
    totalExistingFloorAreaSqm: parcel.total_floor_area_sqm,
    totalBuildings: parcel.total_buildings,
    representativeCoordinates: parcel.representative_coordinates,
    buildings: parcel.buildings.slice(0, 20).map((building) => ({
      permanentBuildingIdentifier: building.permanent_building_id,
      completionYear: building.completion_year,
      numberOfStoreys: building.number_of_storeys,
      floorAreaSqm: building.floor_area_sqm,
      grossFloorAreaSqm: building.gross_floor_area_sqm,
      mainPurposeCode: building.main_purpose_code,
      coordinates: building.coordinates,
    })),
    buildingsTruncated: parcel.buildings.length > 20,
  };
}
