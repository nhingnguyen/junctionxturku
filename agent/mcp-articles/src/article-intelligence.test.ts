import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArticleSearchPlans,
  candidateExclusionReason,
  classifyArticleText,
  inflectFinnishAddress,
  isAllowedArticleUrl,
  normalizeArticleAddress,
} from "./article-intelligence.js";

test("normalizes an apartment address to its parcel-level address", () => {
  const result = normalizeArticleAddress("Karjalankatu 2 C 23, 00520 Helsinki");
  assert.equal(result.normalizedAddress, "Karjalankatu 2");
  assert.equal(result.discardedSuffix, "C 23, 00520 Helsinki");
});

test("generates Finnish inflected street and full-address forms", () => {
  const result = inflectFinnishAddress("Karjalankatu 2");
  assert.ok(result.addressVariants.includes("Karjalankadulla 2"));
  assert.ok(result.addressVariants.includes("Karjalankadun 2"));
  assert.ok(result.streetVariants.includes("Karjalankadulla"));
});

test("builds bounded bilingual address and street plans", () => {
  const plans = buildArticleSearchPlans({
    address: "Veturitie 1 A 2",
    district: "Pasila",
    categories: ["fire_rescue", "water_damage"],
    languages: ["fi", "en"],
    includeSameStreet: true,
    includeNeighborhood: false,
  });

  assert.equal(plans.length, 4);
  assert.ok(plans.every((plan) => plan.query.length <= 600));
  assert.ok(plans.some((plan) => plan.query.includes('"Veturitiellä 1"')));
});

test("classifies exact-address fire evidence as sufficient for an incident claim", () => {
  const classification = classifyArticleText({
    address: "Karjalankatu 2",
    text: "Huoneistopalo syttyi osoitteessa Karjalankatu 2 tiistaina.",
  });

  assert.equal(classification.relation, "exact_address");
  assert.deepEqual(classification.incidentCategories, ["fire_rescue"]);
  assert.equal(classification.sufficientForIncidentClaim, true);
});

test("does not treat a same-street incident as the target building", () => {
  const classification = classifyArticleText({
    address: "Karjalankatu 2",
    text: "Poliisioperaatio sulki Karjalankadun liikenteen usean korttelin matkalta.",
  });

  assert.equal(classification.relation, "same_street");
  assert.equal(classification.sufficientForIncidentClaim, false);
});

test("allows known publishers and rejects arbitrary or local URLs", () => {
  assert.equal(isAllowedArticleUrl("https://www.yle.fi/a/123"), true);
  assert.equal(isAllowedArticleUrl("https://poliisi.fi/-/notice"), true);
  assert.equal(isAllowedArticleUrl("http://localhost:3000/private"), false);
  assert.equal(isAllowedArticleUrl("https://yle.fi.evil.example/a/123"), false);
});

test("only exposes location relations requested by the caller", () => {
  assert.equal(
    candidateExclusionReason({
      relation: "exact_address",
      includeSameStreet: false,
      includeNeighborhood: false,
    }),
    null
  );
  assert.equal(
    candidateExclusionReason({
      relation: "unverified",
      includeSameStreet: true,
      includeNeighborhood: true,
    }),
    "unverified_location"
  );
  assert.equal(
    candidateExclusionReason({
      relation: "same_street",
      includeSameStreet: false,
      includeNeighborhood: false,
    }),
    "same_street_not_requested"
  );
  assert.equal(
    candidateExclusionReason({
      relation: "neighborhood",
      includeSameStreet: false,
      includeNeighborhood: false,
    }),
    "neighborhood_not_requested"
  );
  assert.equal(
    candidateExclusionReason({
      relation: "same_street",
      includeSameStreet: true,
      includeNeighborhood: false,
    }),
    null
  );
});

test("splits Brave address discovery by incident category", () => {
  const plans = buildArticleSearchPlans({
    address: "Aleksis Kiven katu 11",
    categories: ["fire_rescue", "water_damage"],
    languages: ["fi", "en"],
    includeSameStreet: false,
    includeNeighborhood: false,
    splitAddressCategories: true,
  });

  assert.equal(plans.length, 4);
  assert.ok(plans.some((plan) => plan.id === "fi_address_fire_rescue"));
  assert.ok(plans.some((plan) => plan.id === "en_address_water_damage"));
  assert.ok(
    plans.some(
      (plan) =>
        plan.id === "fi_address_fire_rescue" &&
        plan.query === '"Aleksis Kiven katu 11" tulipalo'
    )
  );
  assert.ok(
    plans.every(
      (plan) =>
        !(plan.query.includes('"tulipalo"') && plan.query.includes('"vesivahinko"'))
    )
  );
});
