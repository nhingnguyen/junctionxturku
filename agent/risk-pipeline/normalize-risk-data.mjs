import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RISK_SCHEMA_VERSION = "2.1.0";

const PIPELINE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.dirname(PIPELINE_DIRECTORY);
const DEFAULT_INPUT = path.join(PROJECT_DIRECTORY, "parcels_with_detailed_risks.json");
const DEFAULT_BBOX_PROFILE = path.join(PROJECT_DIRECTORY, "bbox_risk_profile.json");
const DEFAULT_OUTPUT = path.join(PROJECT_DIRECTORY, "parcels_with_normalized_risks.json");

const REQUIRED_RISK_FACTOR_FIELDS = [
  "data",
  "scope",
  "source",
  "as_of",
  "method",
  "freshness",
];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWhitespace(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeAddresses(addresses) {
  if (!Array.isArray(addresses)) return [];

  const seen = new Set();
  const normalized = [];
  for (const value of addresses) {
    if (typeof value !== "string") continue;
    const address = normalizeWhitespace(value);
    if (!address) continue;
    const key = address.toLocaleLowerCase("fi");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(address);
  }
  return normalized;
}

function sourceCatalog(bboxProfile) {
  const railwayLayer = bboxProfile.noise_risk_layers?.railway_noise?.layer ?? null;
  const streetLayer = bboxProfile.noise_risk_layers?.street_noise?.layer ?? null;

  return {
    helsinki_street_noise_2022: {
      publisher: "Helsingin kaupunki",
      dataset: streetLayer,
      license: "CC BY 4.0 (as stated by the source snapshot)",
    },
    helsinki_railway_noise_2022: {
      publisher: "Helsingin kaupunki",
      dataset: railwayLayer,
      license: "CC BY 4.0 (as stated by the source snapshot)",
    },
    syke_fmi_flood_and_elevation: {
      publisher: "SYKE / Finnish Meteorological Institute",
      dataset: "Flood-risk register and construction-height guidance",
      license: "Open-data terms require source-level verification",
    },
    helsinki_environmental_permits: {
      publisher: "Helsingin kaupunkiympäristö",
      dataset: "Environmental permit facilities",
      license: "CC BY 4.0 (as stated by the source snapshot)",
    },
    stuk_radon_statistics: {
      publisher: "STUK",
      dataset: "Postal-code-level indoor radon statistics",
      license: "Open-data terms require source-level verification",
    },
    helsinki_building_registry: {
      publisher: "Helsingin kaupunkiympäristö",
      dataset: "Building Control Registry (RAVA WFS)",
      license: "CC BY 4.0 (as stated by the source snapshot)",
    },
    helsinki_rescue_service_level_2024_2026: {
      publisher: "Helsingin kaupungin pelastuslaitos",
      dataset: "Service Level Decision 2024-2026",
      license: "Public authority data; verify document-specific reuse terms",
    },
    fingrid_grid_status: {
      publisher: "Fingrid Oyj",
      dataset: "National power-system status",
      license: "CC BY 4.0 (as stated by the source snapshot)",
    },
    helen_energiavirasto_reliability: {
      publisher: "Helen Sähköverkko Oy / Energiavirasto",
      dataset: "Local distribution and reliability statistics",
      license: "Open-data terms require source-level verification",
    },
    hsy_water_disruptions: {
      publisher: "HSY",
      dataset: "Water-supply disruption polygons",
      license: "CC BY 4.0 (as stated by the source snapshot)",
      official_information_url:
        "https://www.hsy.fi/vesi-ja-viemarit/vesikatkot-ja-hairiot/",
      live_mapserver_url:
        "https://arcgis.hsy.fi/arcgis/rest/services/H%C3%A4iri%C3%B6viestint%C3%A4kartta_MIL1/MapServer",
    },
  };
}

function scope(level, spatialBasis, inheritedFrom = null) {
  return {
    level,
    spatial_basis: spatialBasis,
    inherited_from: inheritedFrom,
  };
}

function freshness(
  cadence,
  status,
  usableForCurrentState,
  refreshPolicy,
  caveat
) {
  return {
    cadence,
    status,
    usable_for_current_state: usableForCurrentState,
    refresh_policy: refreshPolicy,
    caveat,
  };
}

function factor({
  data,
  scope: factorScope,
  sourceRefs,
  asOf,
  method,
  freshness: value,
  aggregation,
  legacyData,
  legacyDataStatus,
}) {
  return {
    data: copy(data),
    scope: factorScope,
    source: { refs: sourceRefs },
    as_of: asOf,
    method,
    freshness: value,
    ...(aggregation ? { aggregation: copy(aggregation) } : {}),
    ...(legacyData !== undefined ? { legacy_data: copy(legacyData) } : {}),
    ...(legacyDataStatus ? { legacy_data_status: legacyDataStatus } : {}),
  };
}

function buildingAggregation(totalBuildings) {
  if (totalBuildings === 1) {
    return {
      strategy: "single_building",
      input_building_count: 1,
      usable_for_building_specific_claim: true,
      caveat: "The parcel contains one building in the source snapshot.",
    };
  }

  if (totalBuildings > 1) {
    return {
      strategy: "legacy_parcel_summary_unresolved",
      input_building_count: totalBuildings,
      usable_for_building_specific_claim: false,
      caveat:
        "The source contains one fire-characteristics summary for multiple buildings and does not identify the contributing building or aggregation rule.",
    };
  }

  return {
    strategy: "no_building_in_snapshot",
    input_building_count: totalBuildings,
    usable_for_building_specific_claim: false,
    caveat: "No building is recorded on this parcel in the source snapshot.",
  };
}

function legacyFactorData(factorValue) {
  return copy(
    Object.hasOwn(factorValue, "legacy_data")
      ? factorValue.legacy_data
      : factorValue.data
  );
}

function pick(object, keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, copy(object[key])])
  );
}

function omit(object, keys) {
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !excluded.has(key))
      .map(([key, value]) => [key, copy(value)])
  );
}

function normalizePostalCode(value) {
  const match = String(value ?? "").match(/\b\d{5}\b/u);
  if (!match) throw new Error(`Invalid postal code: ${String(value)}`);
  return match[0];
}

function normalizeCoordinates(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("coordinates_wgs84 must contain exactly [longitude, latitude].");
  }
  const coordinates = value.map(Number);
  if (!coordinates.every(Number.isFinite)) {
    throw new Error("coordinates_wgs84 contains a non-numeric value.");
  }
  return coordinates;
}

function environmentalFacilityDates(bboxProfile) {
  return new Map(
    (bboxProfile.environmental_permits ?? []).map((facility) => [
      facility.name,
      facility.last_updated ?? null,
    ])
  );
}

function buildRiskProfileV2(legacyRisk, parcel, bboxProfile) {
  const fire = legacyRisk.fire_and_rescue_safety;
  const power = legacyRisk.power_grid_and_reliability;
  const rescueCoverage = fire.rescue_services_coverage;
  const buildingFire = omit(fire, ["rescue_services_coverage"]);
  const nationalPowerKeys = [
    "national_grid_operator",
    "national_grid_api",
    "national_system_status",
  ];
  const nationalPower = pick(power, nationalPowerKeys);
  const localPower = omit(power, nationalPowerKeys);
  const safeNationalPower = {
    national_grid_operator: nationalPower.national_grid_operator ?? "Fingrid Oyj",
    national_grid_api: nationalPower.national_grid_api ?? "https://data.fingrid.fi",
    national_system_status: "UNKNOWN_REQUIRES_LIVE_CHECK",
    checked_at: null,
  };
  const safeLocalPower = {
    ...localPower,
    weather_outage_risk: "NOT_ASSESSED_FROM_CURRENT_DATA",
  };
  const safeFloodContext = {
    status: "BBOX_CONTEXT_ONLY_NOT_PARCEL_ASSESSED",
    parcel_specific_elevation_meters: null,
    parcel_specific_observed_floods: null,
  };
  const facilityDates = environmentalFacilityDates(bboxProfile);
  const facilityName = legacyRisk.nearest_environmental_permit_site.facility_name;
  const permitAsOf = facilityDates.get(facilityName) ?? null;
  const radonPostalCodes = new Set(
    Object.keys(bboxProfile.indoor_radon_exposure_stuk ?? {})
  );
  const radonCovered = radonPostalCodes.has(parcel.postal_code);
  const fireAggregation = buildingAggregation(parcel.total_buildings);
  const safeRadonData = radonCovered
    ? legacyRisk.indoor_radon_radiation
    : {
        status: "UNAVAILABLE_FOR_POSTAL_CODE",
        details: null,
        postal_code: parcel.postal_code,
        reason: `No STUK radon profile for postal code ${parcel.postal_code} is present in bbox_risk_profile.json.`,
      };
  const legacyWater = legacyRisk.water_network_disruption;
  const safeWaterData = {
    status: "UNKNOWN_REQUIRES_LIVE_CHECK",
    active_disruption: null,
    utility_provider:
      legacyWater.utility_provider ??
      "HSY",
    ...(legacyWater.network_coverage
      ? { network_coverage: legacyWater.network_coverage }
      : {}),
    checked_at: null,
  };

  return {
    static: {
      building_fire_characteristics: factor({
        data: buildingFire,
        scope: scope(
          parcel.total_buildings === 1 ? "single_building" : "parcel_summary",
          parcel.total_buildings === 1
            ? "building-registry attributes for the parcel's only recorded building"
            : "building-registry attributes summarized onto the parcel",
          null
        ),
        sourceRefs: ["helsinki_building_registry"],
        asOf: null,
        method:
          parcel.total_buildings === 1
            ? "Copied from the legacy fire profile for the parcel's only recorded building."
            : "Copied from the legacy parcel fire profile. Multi-building aggregation is not documented and must not be treated as applying to every building.",
        aggregation: fireAggregation,
        freshness: freshness(
          "static",
          "missing_source_timestamp",
          true,
          "Refresh when the building registry snapshot changes.",
          "Building characteristics are relatively stable, but renovations and registry corrections can change them."
        ),
      }),
    },
    periodic: {
      street_traffic_noise: factor({
        data: legacyRisk.street_traffic_noise,
        scope: scope(
          "parcel_representative_point",
          "point-in-polygon at the parcel representative coordinate",
          null
        ),
        sourceRefs: ["helsinki_street_noise_2022"],
        asOf: "2022",
        method:
          "Select the highest matching noise band containing the parcel representative point; this is not a whole-parcel polygon intersection.",
        freshness: freshness(
          "periodic",
          "historical_snapshot",
          false,
          "Refresh when Helsinki publishes a newer strategic noise map.",
          "Use as a 2022 baseline, not as a real-time noise measurement."
        ),
      }),
      railway_noise: factor({
        data: legacyRisk.railway_noise,
        scope: scope(
          "parcel_representative_point",
          "point-in-polygon at the parcel representative coordinate",
          null
        ),
        sourceRefs: ["helsinki_railway_noise_2022"],
        asOf: "2022",
        method:
          "Select the highest matching noise band containing the parcel representative point; this is not a whole-parcel polygon intersection.",
        freshness: freshness(
          "periodic",
          "historical_snapshot",
          false,
          "Refresh when Helsinki publishes a newer strategic noise map.",
          "Use as a 2022 baseline, not as a real-time noise measurement."
        ),
      }),
      flood_and_sea_hazard: factor({
        data: safeFloodContext,
        scope: scope(
          "bbox_context_inherited_by_parcel",
          "the same area-level assessment is copied to every parcel",
          "target_bbox"
        ),
        sourceRefs: ["syke_fmi_flood_and_elevation"],
        asOf: null,
        method:
          "Inherited from the BBOX-level flood and elevation summary; no parcel-specific elevation sampling is present in the source files.",
        freshness: freshness(
          "periodic",
          "missing_source_timestamp",
          false,
          "Refresh from dated SYKE/FMI source layers and calculate parcel-level evidence.",
          "The current value is contextual and must not be described as a parcel-specific flood clearance."
        ),
        legacyData: legacyRisk.flood_and_sea_hazard,
        legacyDataStatus: "bbox_summary_removed_from_parcel_specific_claims",
      }),
      nearest_environmental_permit_site: factor({
        data: legacyRisk.nearest_environmental_permit_site,
        scope: scope(
          "parcel_representative_point",
          "Euclidean distance in EPSG:3879 from the parcel representative point",
          null
        ),
        sourceRefs: ["helsinki_environmental_permits"],
        asOf: permitAsOf,
        method:
          "Choose the shortest planar distance from the parcel representative point to the seven facilities in the source snapshot.",
        freshness: freshness(
          "periodic",
          permitAsOf ? "dated_snapshot" : "missing_source_timestamp",
          false,
          "Refresh when the environmental-permit facility layer changes.",
          "Distance coverage is limited to facilities included in this BBOX snapshot."
        ),
      }),
      indoor_radon_radiation: factor({
        data: safeRadonData,
        scope: scope(
          "postal_code",
          "postal-code statistic inherited by each parcel",
          parcel.postal_code
        ),
        sourceRefs: ["stuk_radon_statistics"],
        asOf: null,
        method:
          "Attach the STUK postal-code risk summary to parcels sharing that postal code.",
        freshness: freshness(
          "periodic",
          radonCovered ? "missing_source_timestamp" : "unverified_fallback",
          false,
          "Refresh from a dated STUK extract covering every postal code in the BBOX.",
          radonCovered
            ? "This is postal-code context, not a measurement from the building."
            : `Postal code ${parcel.postal_code} is absent from bbox_risk_profile.json; the inherited legacy value is retained only for traceability and is not verified for this postal code.`
        ),
        legacyData: radonCovered
          ? undefined
          : legacyRisk.indoor_radon_radiation,
        legacyDataStatus: radonCovered
          ? undefined
          : "unverified_fallback_removed_from_usable_data",
      }),
      rescue_services_coverage: factor({
        data: rescueCoverage,
        scope: scope(
          "operational_risk_area",
          "service-level target inherited by parcels in the area",
          rescueCoverage.operational_risk_class ?? null
        ),
        sourceRefs: ["helsinki_rescue_service_level_2024_2026"],
        asOf: "2024-2026",
        method:
          "Attach the rescue-service target for the stated operational risk class; it is not an observed journey time for this parcel.",
        freshness: freshness(
          "periodic",
          "source_period_recorded",
          false,
          "Replace when a newer rescue-service-level decision takes effect.",
          "Response time is a service target, not a guaranteed arrival time."
        ),
      }),
      local_power_grid_reliability: factor({
        data: safeLocalPower,
        scope: scope(
          "city_or_distribution_area",
          "operator-level statistics inherited by parcels",
          localPower.local_distribution_operator ?? null
        ),
        sourceRefs: ["helen_energiavirasto_reliability"],
        asOf: null,
        method:
          "Attach distribution-operator reliability context and the legacy parcel connection classification.",
        freshness: freshness(
          "periodic",
          "missing_measurement_year",
          false,
          "Refresh from a dated operator/regulator reporting period.",
          "Operator averages do not establish outage risk for an individual parcel; ZERO_STORM_RISK is retained legacy wording and must not be presented as a guarantee."
        ),
        legacyData: localPower,
        legacyDataStatus: "absolute_weather_risk_wording_removed",
      }),
    },
    live: {
      national_power_grid_status: factor({
        data: safeNationalPower,
        scope: scope(
          "national",
          "national system state inherited by every parcel",
          "Finland"
        ),
        sourceRefs: ["fingrid_grid_status"],
        asOf: null,
        method:
          "Copy the national system-state snapshot into parcel context without converting it into parcel-level risk.",
        freshness: freshness(
          "live",
          "missing_observation_timestamp",
          false,
          "Fetch Fingrid live data at request time and retain its observation timestamp.",
          "The stored status must not be described as current because the source snapshot has no observation timestamp."
        ),
        legacyData: nationalPower,
        legacyDataStatus: "untimestamped_snapshot_removed_from_current_state",
      }),
      water_network_disruption: factor({
        data: safeWaterData,
        scope: scope(
          "parcel_representative_point_or_cluster_polygon",
          "legacy intersection with HSY disruption polygons",
          legacyRisk.water_network_disruption.area_name ?? null
        ),
        sourceRefs: ["hsy_water_disruptions"],
        asOf: null,
        method:
          "Retain the legacy parcel/disruption match. The parcel record does not contain event start/end timestamps.",
        freshness: freshness(
          "live",
          "missing_observation_and_expiry_timestamps",
          false,
          "Fetch HSY disruptions at request time and discard events whose end time has passed.",
          "The stored active_disruption flag was removed from usable data. Query the HSY live service before making a current claim."
        ),
        legacyData: legacyRisk.water_network_disruption,
        legacyDataStatus: "untimestamped_snapshot_removed_from_current_state",
      }),
    },
  };
}

export function projectLegacyRiskProfile(riskProfileV2) {
  return {
    street_traffic_noise: legacyFactorData(
      riskProfileV2.periodic.street_traffic_noise
    ),
    railway_noise: legacyFactorData(riskProfileV2.periodic.railway_noise),
    flood_and_sea_hazard: legacyFactorData(
      riskProfileV2.periodic.flood_and_sea_hazard
    ),
    nearest_environmental_permit_site: legacyFactorData(
      riskProfileV2.periodic.nearest_environmental_permit_site
    ),
    indoor_radon_radiation: legacyFactorData(
      riskProfileV2.periodic.indoor_radon_radiation
    ),
    fire_and_rescue_safety: {
      ...legacyFactorData(riskProfileV2.static.building_fire_characteristics),
      rescue_services_coverage: legacyFactorData(
        riskProfileV2.periodic.rescue_services_coverage
      ),
    },
    power_grid_and_reliability: {
      ...legacyFactorData(riskProfileV2.live.national_power_grid_status),
      ...legacyFactorData(riskProfileV2.periodic.local_power_grid_reliability),
    },
    water_network_disruption: legacyFactorData(
      riskProfileV2.live.water_network_disruption
    ),
  };
}

function validateFactor(factorValue, location) {
  for (const field of REQUIRED_RISK_FACTOR_FIELDS) {
    if (!Object.hasOwn(factorValue, field)) {
      throw new Error(`${location} is missing required field ${field}.`);
    }
  }
  if (!Array.isArray(factorValue.source?.refs) || factorValue.source.refs.length === 0) {
    throw new Error(`${location}.source.refs must contain at least one source.`);
  }
}

export function validateNormalizedDataset(dataset, legacyDataset) {
  assert.equal(dataset.schema_version, RISK_SCHEMA_VERSION);
  const normalizedEntries = Object.entries(dataset.parcels);
  const legacyEntries = Object.entries(legacyDataset.parcels);
  assert.equal(normalizedEntries.length, legacyEntries.length);

  for (const [parcelId, parcel] of normalizedEntries) {
    assert.equal(parcel.kiinteistotunnus, parcelId);
    assert.ok(parcel.official_addresses.length > 0);
    assert.ok(parcel.official_addresses.every((address) => address === address.trim()));
    assert.equal(parcel.coordinates_wgs84.length, 2);

    for (const cadence of ["static", "periodic", "live"]) {
      for (const [factorName, factorValue] of Object.entries(
        parcel.risk_profile[cadence]
      )) {
        validateFactor(factorValue, `${parcelId}.${cadence}.${factorName}`);
        assert.equal(factorValue.freshness.cadence, cadence);
      }
    }

    const fireFactor = parcel.risk_profile.static.building_fire_characteristics;
    assert.equal(
      fireFactor.aggregation.input_building_count,
      parcel.total_buildings
    );
    assert.equal(
      fireFactor.aggregation.usable_for_building_specific_claim,
      parcel.total_buildings === 1
    );

    const waterFactor = parcel.risk_profile.live.water_network_disruption;
    assert.equal(waterFactor.data.status, "UNKNOWN_REQUIRES_LIVE_CHECK");
    assert.equal(waterFactor.data.active_disruption, null);
    assert.ok(Object.hasOwn(waterFactor, "legacy_data"));

    assert.deepEqual(
      projectLegacyRiskProfile(parcel.risk_profile),
      legacyDataset.parcels[parcelId].risk_profile,
      `Risk fields were lost or changed for parcel ${parcelId}.`
    );
  }
}

export function transformRiskDataset(legacyDataset, bboxProfile, generatedAt) {
  if (!legacyDataset?.parcels || typeof legacyDataset.parcels !== "object") {
    throw new Error("Input dataset does not contain a parcels object.");
  }

  const actualPostalCodes = new Set();
  const normalization = {
    address_values_trimmed_or_collapsed: 0,
    duplicate_addresses_removed: 0,
  };
  const parcels = {};

  for (const [parcelId, legacyParcel] of Object.entries(legacyDataset.parcels)) {
    if (legacyParcel.kiinteistotunnus !== parcelId) {
      throw new Error(`Parcel key ${parcelId} does not match its kiinteistotunnus.`);
    }

    const rawAddresses = Array.isArray(legacyParcel.official_addresses)
      ? legacyParcel.official_addresses
      : [];
    const addresses = normalizeAddresses(rawAddresses);
    normalization.address_values_trimmed_or_collapsed += rawAddresses.filter(
      (value) =>
        typeof value === "string" && normalizeWhitespace(value) !== value
    ).length;
    normalization.duplicate_addresses_removed += Math.max(
      0,
      rawAddresses.filter((value) => typeof value === "string" && value.trim()).length -
        addresses.length
    );
    if (addresses.length === 0) {
      throw new Error(`Parcel ${parcelId} has no usable official address.`);
    }

    const postalCode = normalizePostalCode(legacyParcel.postal_code);
    actualPostalCodes.add(postalCode);
    const normalizedParcel = {
      kiinteistotunnus: parcelId,
      text_format: normalizeWhitespace(String(legacyParcel.text_format)),
      official_addresses: addresses,
      postal_code: postalCode,
      coordinates_wgs84: normalizeCoordinates(legacyParcel.coordinates_wgs84),
      total_buildings: Number(legacyParcel.total_buildings),
      total_floor_area_sqm: Number(legacyParcel.total_floor_area_sqm),
    };
    normalizedParcel.risk_profile = buildRiskProfileV2(
      legacyParcel.risk_profile,
      normalizedParcel,
      bboxProfile
    );
    parcels[parcelId] = normalizedParcel;
  }

  const dataset = {
    schema_version: RISK_SCHEMA_VERSION,
    generated_at: generatedAt ?? new Date().toISOString(),
    source_snapshot: {
      parcel_risks: path.basename(DEFAULT_INPUT),
      bbox_profile: path.basename(DEFAULT_BBOX_PROFILE),
    },
    metadata: {
      ...copy(legacyDataset.metadata),
      actual_parcel_count: Object.keys(parcels).length,
      actual_postal_codes: [...actualPostalCodes].sort(),
      normalization,
      risk_cadence: {
        static: "Relatively stable property/building attributes.",
        periodic: "Published snapshots that require scheduled refresh.",
        live: "Current-state data that must be fetched and timestamped at request time.",
      },
      known_quality_limits: [
        "Noise values use the parcel representative point, not whole-parcel polygon coverage.",
        "Flood/elevation values are BBOX context copied to every parcel in the legacy dataset.",
        "Radon values outside postal codes present in bbox_risk_profile.json are unavailable; old fallback values exist only in legacy_data for audit.",
        "Multi-building parcels have one legacy building-fire summary with no documented aggregation rule and are blocked from building-specific claims.",
        "Stored live power and water values have no trustworthy observation/expiry timestamp; old water flags exist only in legacy_data and are not valid current-state claims.",
      ],
    },
    source_catalog: sourceCatalog(bboxProfile),
    parcels,
  };

  validateNormalizedDataset(dataset, legacyDataset);
  return dataset;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function main() {
  const input = await readJson(DEFAULT_INPUT);
  const bboxProfile = await readJson(DEFAULT_BBOX_PROFILE);
  const output = transformRiskDataset(input, bboxProfile);
  await writeFile(DEFAULT_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      output: path.basename(DEFAULT_OUTPUT),
      schemaVersion: output.schema_version,
      parcels: Object.keys(output.parcels).length,
      normalization: output.metadata.normalization,
    })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
