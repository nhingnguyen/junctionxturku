import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAddressForDecisions } from "./address-normalizer.js";
import { ParcelIndex } from "./parcel-index.js";

const normalizationCases = [
  ["Viipurinkatu 14 1 C", "Viipurinkatu 14"],
  ["Viipurinkatu 14 C 23", "Viipurinkatu 14"],
  ["Ratapihantie 3 B, 00520 Helsinki", "Ratapihantie 3"],
  ["Asemapäällikönkatu 12 b A 4", "Asemapäällikönkatu 12 b"],
  ["Radanrakentajantie 4-6", "Radanrakentajantie 4-6"],
] as const;

for (const [raw, expected] of normalizationCases) {
  test(`normalizes ${raw} to the parcel-level address`, () => {
    assert.equal(
      normalizeAddressForDecisions(raw).normalizedSearchAddress,
      expected
    );
  });
}

test("resolves an apartment address through the longest official snapshot prefix", () => {
  const resolution = new ParcelIndex().resolveAddress("Viipurinkatu 14 C 23");

  assert.equal(resolution.normalizedSearchAddress, "Viipurinkatu 14");
  assert.equal(resolution.resolutionMethod, "official_address_prefix");
  assert.equal(resolution.parcels.length, 1);
  assert.equal(resolution.parcels[0]?.kiinteistotunnus, "09101203730002");
});

test("resolves an address containing postal code and city", () => {
  const resolution = new ParcelIndex().resolveAddress(
    "Viipurinkatu 14, 00510 Helsinki"
  );

  assert.equal(resolution.normalizedSearchAddress, "Viipurinkatu 14");
  assert.equal(resolution.parcels[0]?.text_format, "91-12-373-2");
});
