
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addSykeUserId } from "./auth.js";

const server = new McpServer({
  name: "ryhti-mcp",
  version: "1.0.0",
});

const SERVICES = {
  building:
    "https://paikkatiedot.ymparisto.fi/geoserver/ryhti_building/ogc/features/v1",
  permit:
    "https://paikkatiedot.ymparisto.fi/geoserver/ryhti_permit/ogc/features/v1",
  inspireBuilding:
    "https://paikkatiedot.ymparisto.fi/geoserver/ryhti_inspire_bu/ogc/features/v1",
  inspireAddress:
    "https://paikkatiedot.ymparisto.fi/geoserver/ryhti_inspire_ad/ogc/features/v1",
} as const;

type ServiceName = keyof typeof SERVICES;

const COLLECTIONS: Record<string, ServiceName> = {
  open_building: "building",
  open_address: "building",
  open_permit_building: "permit",
  open_permit_address: "permit",
  "BU.Building": "inspireBuilding",
  "AD.Address": "inspireAddress",
};

const COLLECTION_NAMES = [
  "open_building",
  "open_address",
  "open_permit_building",
  "open_permit_address",
  "BU.Building",
  "AD.Address",
] as const;

const collectionSchema = z.enum(COLLECTION_NAMES).describe(
  "Ryhti collection. Use open_address for normal address and postal-code searches."
);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_RESULT_CHARACTERS = 60_000;

function getBase(collection: string): string {
  const service = COLLECTIONS[collection];

  if (!service) {
    throw new Error(
      `Unsupported collection: ${collection}. ` +
      "Call ryhti_list_collections to inspect available collections."
    );
  }

  return SERVICES[service];
}

async function getJson(
  url: URL,
  timeoutMs = 20000,
  accept = "application/geo+json, application/json"
): Promise<any> {
  const response = await fetch(addSykeUserId(url), {
    headers: {
      Accept: accept,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `Ryhti API returned HTTP ${response.status}: ` +
      (await response.text()).slice(0, 1000)
    );
  }

  return response.json();
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
            error: "Ryhti result is too large for the LLM context.",
            resultCharacters: text.length,
            maximumCharacters: MAX_RESULT_CHARACTERS,
            suggestion:
              "Use a smaller limit, a bbox or a server-side filter. Only request geometry when it is required.",
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

function removeFeatureGeometry(data: any): any {
  if (!Array.isArray(data?.features)) return data;

  return {
    ...data,
    features: data.features.map((feature: any) => {
      if (!feature || typeof feature !== "object") return feature;
      const { geometry: _geometry, ...featureWithoutGeometry } = feature;
      return featureWithoutGeometry;
    }),
  };
}

function normalizePermanentBuildingIdentifier(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (!/^[0-9A-Z]{10}$/.test(normalized)) {
    throw new Error(
      `Invalid permanent building identifier: ${value}. Expected 10 letters or digits.`
    );
  }

  return normalized;
}

// 1. Khám phá các collection của Ryhti.
server.tool(
  "ryhti_list_collections",
  "List available Ryhti data collections for buildings, addresses and permits.",
  {
    service: z.enum([
      "building",
      "permit",
      "inspireBuilding",
      "inspireAddress",
    ]).default("building"),
  },
  async ({ service }) => {
    const url = new URL(`${SERVICES[service]}/collections`);
    url.searchParams.set("f", "json");

    return result(await getJson(url));
  }
);

// 2. Lấy schema các trường có thể truy vấn.
// Nên gọi tool này trước khi viết filter theo tên trường.
server.tool(
  "ryhti_get_queryables",
  "Get queryable field names and types for a Ryhti collection.",
  {
    collection: collectionSchema,
  },
  async ({ collection }) => {
    const url = new URL(
      `${getBase(collection)}/collections/` +
      `${encodeURIComponent(collection)}/queryables`
    );
    url.searchParams.set("f", "application/schema+json");

    return result(
      await getJson(url, 20000, "application/schema+json")
    );
  }
);

// 3. Tìm feature theo giới hạn, offset, bbox và filter.
// GeoServer nhận offset qua tham số `startIndex`.
// bbox sử dụng CRS do API quy định; mặc định là EPSG:4326
// theo cách triển khai phổ biến của OGC API Features.
// Với bbox EPSG:3067, phải truyền bbox-crs tương ứng.
server.tool(
  "ryhti_get_features",
  "Query Ryhti buildings, addresses or permits. For a postal code search, use collection open_address and a CQL2 filter such as postal_code = '00520'.",
  {
    collection: collectionSchema,
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
    bbox: z.array(z.number()).length(4).optional()
      .describe("Bounding box [minX,minY,maxX,maxY]."),
    bboxCrs: z.string().optional()
      .describe("Optional bbox CRS URI, e.g. EPSG:3067 URI."),
    filter: z.string().optional()
      .describe("Optional server-side filter. Inspect queryables first."),
    filterLang: z.enum(["cql2-text", "cql2-json"]).optional(),
    includeGeometry: z.boolean().default(false)
      .describe("Include GeoJSON geometry only when it is needed for a map."),
  },
  async ({
    collection,
    limit,
    offset,
    bbox,
    bboxCrs,
    filter,
    filterLang,
    includeGeometry,
  }) => {
    const url = new URL(
      `${getBase(collection)}/collections/` +
      `${encodeURIComponent(collection)}/items`
    );

    url.searchParams.set("f", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("startIndex", String(offset));

    if (bbox) {
      url.searchParams.set("bbox", bbox.join(","));
    }

    if (bboxCrs) {
      url.searchParams.set("bbox-crs", bboxCrs);
    }

    if (filter) {
      url.searchParams.set("filter", filter);
    }

    if (filterLang) {
      url.searchParams.set("filter-lang", filterLang);
    }

    const rawData = await getJson(url);
    const data = includeGeometry
      ? rawData
      : removeFeatureGeometry(rawData);

    return result({
      collection,
      requestedLimit: limit,
      requestedOffset: offset,
      geometryIncluded: includeGeometry,
      returnedFeatures: data.features?.length ?? 0,
      numberMatched: data.numberMatched ?? null,
      nextPageAvailable: Boolean(
        data.links?.some((link: { rel?: string }) =>
          link.rel === "next"
        )
      ),
      data,
    });
  }
);

// 4. Lấy một feature theo ID.
server.tool(
  "ryhti_get_feature",
  "Retrieve a single Ryhti feature by collection and feature ID.",
  {
    collection: collectionSchema,
    featureId: z.string(),
  },
  async ({ collection, featureId }) => {
    const url = new URL(
      `${getBase(collection)}/collections/` +
      `${encodeURIComponent(collection)}/items/` +
      `${encodeURIComponent(featureId)}`
    );
    url.searchParams.set("f", "json");

    return result(await getJson(url));
  }
);

server.tool(
  "ryhti_get_buildings_by_permanent_identifiers",
  "Get Ryhti building details in one request for permanent building identifiers returned by mml_find_nearby_buildings. completion_date contains the official completion date when available.",
  {
    permanentBuildingIdentifiers: z.array(z.string()).min(1).max(10)
      .describe("One to ten Finnish permanent building identifiers."),
  },
  async ({ permanentBuildingIdentifiers }) => {
    const identifiers = [
      ...new Set(
        permanentBuildingIdentifiers.map(normalizePermanentBuildingIdentifier)
      ),
    ];
    const filter = identifiers
      .map(
        (identifier) =>
          `permanent_building_identifier = '${identifier}'`
      )
      .join(" OR ");
    const url = new URL(
      `${getBase("open_building")}/collections/open_building/items`
    );
    url.searchParams.set("f", "json");
    url.searchParams.set("limit", String(Math.min(identifiers.length * 2, MAX_LIMIT)));
    url.searchParams.set("filter", filter);
    url.searchParams.set("filter-lang", "cql2-text");

    const data = removeFeatureGeometry(await getJson(url));

    return result({
      collection: "open_building",
      requestedPermanentBuildingIdentifiers: identifiers,
      returnedBuildings: data.features?.length ?? 0,
      data,
    });
  }
);

// Dùng stderr cho log để không làm hỏng giao thức stdio.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ryhti MCP server started.");
}

main().catch((error) => {
  console.error("Ryhti MCP failed:", error);
  process.exitCode = 1;
});
