import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getMmlAuthHeaders } from "./auth.js";

const server = new McpServer({
  name: "mml-mcp",
  version: "1.0.0",
});

const DEFAULT_BASE_URL =
  "https://avoin-paikkatieto.maanmittauslaitos.fi/kiinteisto-avoin/simple-features/v3";
const DEFAULT_GEOCODING_BASE_URL =
  "https://avoin-paikkatieto.maanmittauslaitos.fi/geocoding/v2";
const BASE_URL = (process.env.MML_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
  /\/+$/,
  ""
);
const GEOCODING_BASE_URL = (
  process.env.MML_GEOCODING_BASE_URL?.trim() || DEFAULT_GEOCODING_BASE_URL
).replace(/\/+$/, "");
const PARCEL_COLLECTION = "PalstanSijaintitiedot";
const MAX_RESULT_CHARACTERS = 60_000;

interface JsonObject {
  features?: unknown[];
  numberMatched?: number;
  numberReturned?: number;
  [key: string]: unknown;
}

interface GeoJsonFeature {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
}

function normalizePropertyIdentifier(value: string): string {
  const normalized = value.replace(/[\s-]/g, "");

  if (!/^\d{14}$/.test(normalized)) {
    throw new Error(
      "propertyIdentifier must contain 14 digits, for example 091-002-0001-0010."
    );
  }

  return normalized;
}

async function getJson(url: URL, timeoutMs = 20_000): Promise<JsonObject> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/json",
      ...getMmlAuthHeaders(),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`MML API returned HTTP ${response.status}: ${detail}`);
  }

  return response.json() as Promise<JsonObject>;
}

function removeGeometry(data: JsonObject): JsonObject {
  if (!Array.isArray(data.features)) {
    const { geometry: _geometry, ...withoutGeometry } = data;
    return withoutGeometry;
  }

  return {
    ...data,
    features: data.features.map((feature) => {
      if (!feature || typeof feature !== "object") return feature;
      const { geometry: _geometry, ...withoutGeometry } = feature as Record<
        string,
        unknown
      >;
      return withoutGeometry;
    }),
  };
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
            error: "MML result is too large for the LLM context.",
            resultCharacters: text.length,
            maximumCharacters: MAX_RESULT_CHARACTERS,
            suggestion: "Retry without geometry or use a more specific property identifier.",
          }),
        },
      ],
    };
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}

function getPoint(feature: GeoJsonFeature): [number, number] | null {
  const coordinates = feature.geometry?.coordinates;

  if (
    feature.geometry?.type !== "Point" ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    typeof coordinates[0] !== "number" ||
    typeof coordinates[1] !== "number"
  ) {
    return null;
  }

  return [coordinates[0], coordinates[1]];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

server.tool(
  "mml_geocode_place",
  "Resolve a Finnish landmark or place name to WGS84 coordinates using MML's official geographic-name registry. Finnish or Swedish official names work best.",
  {
    query: z.string().min(2)
      .describe("Place name with municipality, preferably in Finnish or Swedish."),
    language: z.enum(["fi", "sv", "en"]).default("fi"),
    limit: z.number().int().min(1).max(5).default(3),
  },
  async ({ query, language, limit }) => {
    const url = new URL(`${GEOCODING_BASE_URL}/pelias/search`);
    url.searchParams.set("text", query);
    url.searchParams.set("sources", "geographic-names");
    url.searchParams.set("lang", language);
    url.searchParams.set("size", String(limit));

    const data = await getJson(url);
    const candidates = (data.features ?? [])
      .map((item) => {
        const feature = item as GeoJsonFeature;
        const point = getPoint(feature);
        if (!point) return null;

        const properties = feature.properties ?? {};
        return {
          label: optionalString(properties.label),
          municipality:
            optionalString(properties["label:municipality"]) ??
            optionalString(properties.municipality),
          source: optionalString(properties.source),
          matchType: optionalString(properties.match_type),
          longitude: point[0],
          latitude: point[1],
        };
      })
      .filter((candidate) => candidate !== null);

    return result({
      source: "Maanmittauslaitos (MML) Geocoding Service",
      query,
      language,
      returnedCandidates: candidates.length,
      candidates,
    });
  }
);

server.tool(
  "mml_find_nearby_buildings",
  "Find the nearest Finnish building addresses around WGS84 coordinates. Returns distance, address, permanent building identifier and property identifier for a follow-up Ryhti building lookup.",
  {
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    radiusMeters: z.number().int().min(10).max(2000).default(250),
    limit: z.number().int().min(1).max(10).default(5),
    language: z.enum(["fi", "sv", "en"]).default("fi"),
  },
  async ({ longitude, latitude, radiusMeters, limit, language }) => {
    const url = new URL(`${GEOCODING_BASE_URL}/pelias/reverse`);
    url.searchParams.set("point.lon", String(longitude));
    url.searchParams.set("point.lat", String(latitude));
    url.searchParams.set("sources", "addresses");
    url.searchParams.set("boundary.circle.radius", String(radiusMeters));
    url.searchParams.set("lang", language);
    url.searchParams.set("size", String(Math.min(limit * 4, 40)));

    const data = await getJson(url);
    const seenBuildings = new Set<string>();
    const nearbyBuildings = (data.features ?? [])
      .map((item) => {
        const feature = item as GeoJsonFeature;
        const point = getPoint(feature);
        const properties = feature.properties ?? {};
        const permanentBuildingIdentifier = optionalString(
          properties.rakennustunnus
        );

        if (!point || !permanentBuildingIdentifier) return null;

        const distance = Number(properties.distance);
        return {
          address: optionalString(properties.label),
          distanceMeters: Number.isFinite(distance)
            ? Math.round(distance * 10) / 10
            : null,
          permanentBuildingIdentifier,
          propertyIdentifier: optionalString(properties.kiinteistotunnus),
          municipalityNumber:
            optionalString(properties.kuntatunnus) ??
            optionalString(properties.municipality),
          postalCode: optionalString(
            properties["osoite.Osoite.postinumero"]
          ),
          longitude: point[0],
          latitude: point[1],
        };
      })
      .filter((building) => building !== null)
      .sort(
        (left, right) =>
          (left.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (right.distanceMeters ?? Number.POSITIVE_INFINITY)
      )
      .filter((building) => {
        if (seenBuildings.has(building.permanentBuildingIdentifier)) {
          return false;
        }
        seenBuildings.add(building.permanentBuildingIdentifier);
        return true;
      })
      .slice(0, limit);

    return result({
      source: "Maanmittauslaitos (MML) Geocoding Service",
      center: { longitude, latitude },
      radiusMeters,
      returnedBuildings: nearbyBuildings.length,
      nearbyBuildings,
    });
  }
);

server.tool(
  "mml_get_parcels_by_property_identifier",
  "Get official Finnish cadastral parcel geometry and attributes using a 14-digit property identifier from Ryhti.",
  {
    propertyIdentifier: z.string()
      .describe("Finnish property identifier, with or without hyphens."),
    includeGeometry: z.boolean().default(false)
      .describe("Include parcel GeoJSON geometry only when it is needed for a map."),
  },
  async ({ propertyIdentifier, includeGeometry }) => {
    const normalizedIdentifier = normalizePropertyIdentifier(propertyIdentifier);
    const url = new URL(
      `${BASE_URL}/collections/${PARCEL_COLLECTION}/items`
    );
    url.searchParams.set("f", "json");
    url.searchParams.set("limit", "10");
    url.searchParams.set("kiinteistotunnus", normalizedIdentifier);

    const rawData = await getJson(url);
    const data = includeGeometry
      ? rawData
      : removeGeometry(rawData);

    return result({
      source: "Maanmittauslaitos (MML)",
      collection: PARCEL_COLLECTION,
      propertyIdentifier: normalizedIdentifier,
      geometryIncluded: includeGeometry,
      returnedParcels: data.features?.length ?? data.numberReturned ?? 0,
      data,
    });
  }
);

server.tool(
  "mml_get_parcel_by_feature_id",
  "Retrieve one official Finnish cadastral parcel by its MML feature ID.",
  {
    featureId: z.string().min(1),
    includeGeometry: z.boolean().default(false),
  },
  async ({ featureId, includeGeometry }) => {
    const url = new URL(
      `${BASE_URL}/collections/${PARCEL_COLLECTION}/items/${encodeURIComponent(featureId)}`
    );
    url.searchParams.set("f", "json");

    const rawData = await getJson(url);
    const data = includeGeometry
      ? rawData
      : removeGeometry(rawData);

    return result({
      source: "Maanmittauslaitos (MML)",
      collection: PARCEL_COLLECTION,
      featureId,
      geometryIncluded: includeGeometry,
      data,
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MML MCP server started.");
}

main().catch((error) => {
  console.error("MML MCP failed:", error);
  process.exitCode = 1;
});
