import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeAddresses,
  projectLegacyRiskProfile,
  transformRiskDataset,
  validateNormalizedDataset,
} from "./normalize-risk-data.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(directory);

async function fixture(name) {
  return JSON.parse(await readFile(path.join(project, name), "utf8"));
}

test("normalizes, trims and de-duplicates Finnish addresses", () => {
  assert.deepEqual(
    normalizeAddresses([" Topparikuja  ", "Topparikuja", "OPASTINSILTA 2", "Opastinsilta 2"]),
    ["Topparikuja", "OPASTINSILTA 2"]
  );
});

test("creates a validated v2 dataset without losing legacy risk fields", async () => {
  const legacy = await fixture("parcels_with_detailed_risks.json");
  const bboxProfile = await fixture("bbox_risk_profile.json");
  const normalized = transformRiskDataset(
    legacy,
    bboxProfile,
    "2026-10-18T00:00:00.000Z"
  );

  validateNormalizedDataset(normalized, legacy);
  assert.equal(Object.keys(normalized.parcels).length, 404);
  assert.equal(normalized.metadata.normalization.address_values_trimmed_or_collapsed, 22);
  assert.ok(normalized.metadata.actual_postal_codes.includes("00240"));

  const opastinsilta = normalized.parcels["09101700230003"];
  assert.deepEqual(opastinsilta.official_addresses, ["Opastinsilta 2", "Topparikuja"]);
  assert.ok(opastinsilta.risk_profile.static.building_fire_characteristics);
  assert.ok(opastinsilta.risk_profile.periodic.street_traffic_noise);
  assert.ok(opastinsilta.risk_profile.live.water_network_disruption);
  assert.deepEqual(
    projectLegacyRiskProfile(opastinsilta.risk_profile),
    legacy.parcels["09101700230003"].risk_profile
  );
});

test("removes unsupported radon fallback and untimestamped water flags from usable data", async () => {
  const legacy = await fixture("parcels_with_detailed_risks.json");
  const bboxProfile = await fixture("bbox_risk_profile.json");
  const normalized = transformRiskDataset(
    legacy,
    bboxProfile,
    "2026-10-18T00:00:00.000Z"
  );

  const unsupported = Object.values(normalized.parcels).find(
    (parcel) => parcel.postal_code === "00240"
  );
  assert.equal(
    unsupported.risk_profile.periodic.indoor_radon_radiation.freshness.status,
    "unverified_fallback"
  );
  assert.equal(
    unsupported.risk_profile.periodic.indoor_radon_radiation.data.status,
    "UNAVAILABLE_FOR_POSTAL_CODE"
  );
  assert.equal(
    unsupported.risk_profile.periodic.indoor_radon_radiation.legacy_data_status,
    "unverified_fallback_removed_from_usable_data"
  );
  assert.equal(
    unsupported.risk_profile.periodic.indoor_radon_radiation.freshness
      .usable_for_current_state,
    false
  );
  assert.equal(
    unsupported.risk_profile.live.national_power_grid_status.freshness
      .usable_for_current_state,
    false
  );
  assert.equal(
    unsupported.risk_profile.live.national_power_grid_status.data
      .national_system_status,
    "UNKNOWN_REQUIRES_LIVE_CHECK"
  );
  assert.equal(
    unsupported.risk_profile.periodic.flood_and_sea_hazard.data.status,
    "BBOX_CONTEXT_ONLY_NOT_PARCEL_ASSESSED"
  );
  assert.equal(
    unsupported.risk_profile.periodic.local_power_grid_reliability.data
      .weather_outage_risk,
    "NOT_ASSESSED_FROM_CURRENT_DATA"
  );
  assert.equal(
    unsupported.risk_profile.live.water_network_disruption.freshness
      .usable_for_current_state,
    false
  );
  assert.equal(
    unsupported.risk_profile.live.water_network_disruption.data.active_disruption,
    null
  );
  assert.equal(
    unsupported.risk_profile.live.water_network_disruption.data.status,
    "UNKNOWN_REQUIRES_LIVE_CHECK"
  );
  assert.ok(
    Object.hasOwn(
      unsupported.risk_profile.live.water_network_disruption,
      "legacy_data"
    )
  );
});

test("blocks unresolved multi-building fire summaries from building-specific claims", async () => {
  const legacy = await fixture("parcels_with_detailed_risks.json");
  const bboxProfile = await fixture("bbox_risk_profile.json");
  const normalized = transformRiskDataset(
    legacy,
    bboxProfile,
    "2026-10-18T00:00:00.000Z"
  );

  const singleBuilding = normalized.parcels["09101700230003"];
  assert.equal(
    singleBuilding.risk_profile.static.building_fire_characteristics.aggregation
      .strategy,
    "single_building"
  );
  assert.equal(
    singleBuilding.risk_profile.static.building_fire_characteristics.aggregation
      .usable_for_building_specific_claim,
    true
  );

  const multiBuilding = Object.values(normalized.parcels).find(
    (parcel) => parcel.total_buildings > 1
  );
  assert.ok(multiBuilding);
  assert.equal(
    multiBuilding.risk_profile.static.building_fire_characteristics.aggregation
      .strategy,
    "legacy_parcel_summary_unresolved"
  );
  assert.equal(
    multiBuilding.risk_profile.static.building_fire_characteristics.aggregation
      .usable_for_building_specific_claim,
    false
  );
});
