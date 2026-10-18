import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HsyWaterClient } from "./hsy-water.js";
import {
  compactRiskParcel,
  RiskIndex,
  selectRiskProfile,
  type RiskCadence,
  type RiskParcelResolution,
} from "./risk-index.js";

const server = new McpServer({
  name: "property-risk-mcp",
  version: "1.0.0",
});

const MAX_RESULT_CHARACTERS = 60_000;
let riskIndex: RiskIndex | undefined;
let waterClient: HsyWaterClient | undefined;

function getRiskIndex(): RiskIndex {
  riskIndex ??= new RiskIndex();
  return riskIndex;
}

function getWaterClient(): HsyWaterClient {
  waterClient ??= new HsyWaterClient();
  return waterClient;
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
            error: "Risk result is too large for the LLM context.",
            resultCharacters: text.length,
            maximumCharacters: MAX_RESULT_CHARACTERS,
            suggestion: "Request fewer cadence sections and omit legacy evidence.",
          }),
        },
      ],
    };
  }
  return { content: [{ type: "text" as const, text }] };
}

function unresolvedResult(resolution: Exclude<RiskParcelResolution, { status: "resolved" }>) {
  return result({
    source: "Local normalized parcel-risk snapshot",
    resolutionStatus: resolution.status,
    normalizedPropertyIdentifier: resolution.normalizedPropertyIdentifier,
    addressResolution: resolution.addressResolution
      ? {
          rawAddress: resolution.addressResolution.rawAddress,
          normalizedSearchAddress:
            resolution.addressResolution.normalizedSearchAddress,
          officialAddress: resolution.addressResolution.officialAddress,
          discardedSuffix: resolution.addressResolution.discardedSuffix,
          resolutionMethod: resolution.addressResolution.resolutionMethod,
        }
      : null,
    candidateParcels: resolution.parcels.map(compactRiskParcel),
    suggestion:
      resolution.status === "ambiguous_address"
        ? "Choose one property identifier before requesting the risk profile."
        : "Confirm the official parcel-level address or property identifier. The local snapshot covers only its configured Helsinki bbox.",
  });
}

function referencedSourceCatalog(
  index: RiskIndex,
  profile: Partial<
    Record<RiskCadence, Record<string, { source: { refs: string[] } }>>
  >
) {
  const references = new Set<string>();
  for (const factors of Object.values(profile)) {
    for (const factor of Object.values(factors ?? {})) {
      for (const reference of factor.source.refs) references.add(reference);
    }
  }
  return Object.fromEntries(
    [...references].map((reference) => [
      reference,
      index.sourceCatalog[reference] ?? { missingFromCatalog: true },
    ])
  );
}

server.tool(
  "risk_get_property_profile",
  "Resolve a parcel by Finnish property identifier or official/listing address and return normalized static, periodic and/or live risk evidence. Stale water flags and unsupported radon fallback values are excluded by default.",
  {
    propertyIdentifier: z.string().min(3).max(64).optional(),
    address: z.string().min(2).max(200).optional(),
    sections: z
      .array(z.enum(["static", "periodic", "live"]))
      .min(1)
      .max(3)
      .optional()
      .describe("Cadence groups to return. Defaults to all three."),
    includeLegacyEvidence: z
      .boolean()
      .optional()
      .default(false)
      .describe("Audit only. Includes unusable pre-normalization values."),
  },
  async ({ propertyIdentifier, address, sections, includeLegacyEvidence }) => {
    if (!propertyIdentifier && !address) {
      throw new Error("Provide propertyIdentifier or address.");
    }
    const index = getRiskIndex();
    const resolution = index.resolve(propertyIdentifier, address);
    if (resolution.status !== "resolved") return unresolvedResult(resolution);

    const selectedSections = (sections ?? ["static", "periodic", "live"]) as RiskCadence[];
    const profile = selectRiskProfile(
      resolution.parcel,
      selectedSections,
      includeLegacyEvidence
    );
    const fireAggregation =
      resolution.parcel.risk_profile.static.building_fire_characteristics
        .aggregation;

    return result({
      source: "Local normalized parcel-risk snapshot",
      schemaVersion: index.schemaVersion,
      snapshotGeneratedAt: index.generatedAt,
      resolutionStatus: "resolved",
      matchedBy: resolution.matchedBy,
      parcel: compactRiskParcel(resolution.parcel),
      addressResolution: resolution.addressResolution
        ? {
            officialAddress: resolution.addressResolution.officialAddress,
            discardedSuffix: resolution.addressResolution.discardedSuffix,
            resolutionMethod: resolution.addressResolution.resolutionMethod,
          }
        : null,
      requestedSections: selectedSections,
      legacyEvidenceIncluded: includeLegacyEvidence,
      interpretation: {
        buildingSpecificFireClaimAllowed:
          fireAggregation?.usable_for_building_specific_claim === true,
        currentWaterStateRequiresTool: "risk_check_live_water_disruptions",
        noCompositeRiskScore:
          "Factors have different spatial scopes and timestamps; do not invent a combined LOW/MEDIUM/HIGH score.",
      },
      riskProfile: profile,
      sourceCatalog: referencedSourceCatalog(index, profile),
    });
  }
);

server.tool(
  "risk_check_live_water_disruptions",
  "Resolve a local parcel and check all six official HSY water-disruption polygon layers at its representative WGS84 coordinate. Filters events by start and end time and reports the exact check timestamp.",
  {
    propertyIdentifier: z.string().min(3).max(64).optional(),
    address: z.string().min(2).max(200).optional(),
  },
  async ({ propertyIdentifier, address }) => {
    if (!propertyIdentifier && !address) {
      throw new Error("Provide propertyIdentifier or address.");
    }
    const index = getRiskIndex();
    const resolution = index.resolve(propertyIdentifier, address);
    if (resolution.status !== "resolved") return unresolvedResult(resolution);

    const [longitude, latitude] = resolution.parcel.coordinates_wgs84;
    const live = await getWaterClient().checkPoint(longitude, latitude);
    return result({
      resolutionStatus: "resolved",
      matchedBy: resolution.matchedBy,
      parcel: compactRiskParcel(resolution.parcel),
      liveWaterStatus: live,
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Property Risk MCP server started.");
}

main().catch((error) => {
  console.error("Property Risk MCP failed:", error);
  process.exitCode = 1;
});
