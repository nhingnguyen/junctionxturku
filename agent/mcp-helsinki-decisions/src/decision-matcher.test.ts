import assert from "node:assert/strict";
import test from "node:test";
import { classifyParcelDecision } from "./decision-matcher.js";
import { formatParcelIdentifier } from "./parcel-index.js";

const selectedParcelIdentifier = "91-12-369-1";

test("classifies matching parcel ID and address as a verified strong match", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    selectedAddresses: ["Karjalankatu 2"],
    fields: [
      {
        field: "decision_content",
        text: "Kiinteistötunnus 91-12-369-1, osoite Karjalankatu 2, Helsinki.",
      },
    ],
  });

  assert.equal(match.matchType, "exact_parcel_and_address");
  assert.equal(match.verified, true);
  assert.equal(match.score, 100);
  assert.deepEqual(
    match.evidence.map((item) => item.evidenceType).sort(),
    ["address", "parcel_id"]
  );
});

test("classifies an exact parcel ID without an address as verified", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    selectedAddresses: ["Karjalankatu 2"],
    fields: [
      {
        field: "subject",
        text: "Vuokraus, kiinteistö 09101203690001",
      },
    ],
  });

  assert.equal(match.matchType, "exact_parcel_id_only");
  assert.equal(match.verified, true);
  assert.equal(match.parcelIdentifiersFound[0]?.normalized, "09101203690001");
});

test("flags an address match with a different parcel ID as a conflict", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    selectedAddresses: ["Karjalankatu 2"],
    fields: [
      {
        field: "decision_content",
        text: "Osoite Karjalankatu 2 ja kiinteistötunnus 91-12-387-72.",
      },
    ],
  });

  assert.equal(match.matchType, "conflict");
  assert.equal(match.verified, false);
  assert.equal(
    match.conflictingParcelIdentifiers[0]?.normalized,
    "09101203870072"
  );
});

test("classifies an explicit reference to the selected block as broader context", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    selectedAddresses: ["Karjalankatu 2"],
    fields: [
      {
        field: "issue_subject",
        text: "Asemakaavan muuttaminen korttelissa 369",
      },
    ],
  });

  assert.equal(match.matchType, "broader_block_context");
  assert.equal(match.verified, false);
  assert.ok(match.evidence.some((item) => item.evidenceType === "block"));
});

test("keeps an unrelated search candidate unclassified", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    fields: [
      {
        field: "subject",
        text: "Rakennuksen korjaaminen palovahingon jälkeen",
      },
    ],
  });

  assert.equal(match.matchType, "unclassified");
  assert.equal(match.verified, false);
  assert.equal(match.score, 0);
});

test("formats a normalized 14-digit property identifier", () => {
  assert.equal(formatParcelIdentifier("09101203690001"), "91-12-369-1");
});

test("recognizes non-breaking hyphens used in official decision text", () => {
  const match = classifyParcelDecision({
    selectedParcelIdentifier,
    fields: [
      {
        field: "decision_content",
        text: "Päätös koskee kiinteistöä 91‑12‑369‑1.",
      },
    ],
  });

  assert.equal(match.matchType, "exact_parcel_id_only");
  assert.equal(match.verified, true);
});
