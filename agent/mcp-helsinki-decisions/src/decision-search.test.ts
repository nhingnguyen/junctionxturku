import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDualPassSearchPlans,
  quoteExactPhrase,
  selectDualPassResults,
} from "./decision-search.js";

test("builds exactly two quoted phrase passes without keyword filters", () => {
  const plans = buildDualPassSearchPlans("91-12-373-2", "Viipurinkatu 14");

  assert.equal(plans.length, 2);
  assert.deepEqual(plans, [
    {
      stage: "pass_1_parcel_id",
      query: '"91-12-373-2"',
      phrase: true,
    },
    {
      stage: "pass_2_address",
      query: '"Viipurinkatu 14"',
      phrase: true,
    },
  ]);
});

test("removes user-provided quote characters before quoting a phrase", () => {
  assert.equal(quoteExactPhrase('  "Viipurinkatu 14"  '), '"Viipurinkatu 14"');
});

test("keeps both parcel-only and historical address-only results in limited output", () => {
  const selected = selectDualPassResults(
    [
      { id: "parcel-1", foundByPasses: ["pass_1_parcel_id"] },
      { id: "parcel-2", foundByPasses: ["pass_1_parcel_id"] },
      { id: "address-1", foundByPasses: ["pass_2_address"] },
    ],
    2
  );

  assert.deepEqual(
    selected.map((item) => item.id),
    ["parcel-1", "address-1"]
  );
});
