import assert from "node:assert/strict";
import test from "node:test";
import { RiskIndex, selectRiskProfile } from "./risk-index.js";

test("resolves a normalized risk parcel by formatted identifier and listing address", () => {
  const index = new RiskIndex();
  const byIdentifier = index.resolve("91-17-23-3");
  assert.equal(byIdentifier.status, "resolved");
  if (byIdentifier.status !== "resolved") return;
  assert.equal(byIdentifier.parcel.kiinteistotunnus, "09101700230003");

  const byAddress = index.resolve(undefined, "Opastinsilta 2 A 13, 00520 Helsinki");
  assert.equal(byAddress.status, "resolved");
  if (byAddress.status !== "resolved") return;
  assert.equal(byAddress.parcel.kiinteistotunnus, "09101700230003");
  assert.equal(byAddress.addressResolution?.officialAddress, "Opastinsilta 2");
});

test("returns safe radon and water data while hiding legacy evidence by default", () => {
  const index = new RiskIndex();
  const resolution = index.resolve(undefined, "Ilmalantori 1");
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;

  const profile = selectRiskProfile(
    resolution.parcel,
    ["periodic", "live"],
    false
  );
  const radon = profile.periodic?.indoor_radon_radiation;
  const water = profile.live?.water_network_disruption;
  const nationalPower = profile.live?.national_power_grid_status;
  const flood = profile.periodic?.flood_and_sea_hazard;
  assert.equal(radon?.data.status, "UNAVAILABLE_FOR_POSTAL_CODE");
  assert.equal(Object.hasOwn(radon ?? {}, "legacy_data"), false);
  assert.equal(water?.data.status, "UNKNOWN_REQUIRES_LIVE_CHECK");
  assert.equal(water?.data.active_disruption, null);
  assert.equal(Object.hasOwn(water ?? {}, "legacy_data"), false);
  assert.equal(
    nationalPower?.data.national_system_status,
    "UNKNOWN_REQUIRES_LIVE_CHECK"
  );
  assert.equal(
    flood?.data.status,
    "BBOX_CONTEXT_ONLY_NOT_PARCEL_ASSESSED"
  );
});

test("exposes explicit aggregation policy for multi-building parcels", () => {
  const index = new RiskIndex();
  const resolution = index.resolve("91-12-374-1");
  assert.equal(resolution.status, "resolved");
  if (resolution.status !== "resolved") return;
  const aggregation =
    resolution.parcel.risk_profile.static.building_fire_characteristics
      .aggregation;
  assert.equal(aggregation?.strategy, "legacy_parcel_summary_unresolved");
  assert.equal(aggregation?.usable_for_building_specific_claim, false);
});
