import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeArticleAddress } from "./article-intelligence.js";

interface SmokeResult {
  provider?: { provider?: string };
  target?: { normalizedAddress?: string };
  searchCoverage?: {
    queriesAttempted?: number;
    queriesSucceeded?: number;
    queriesFailed?: number;
    queries?: Array<{ error?: string | null }>;
  };
  returnedCandidates?: number;
  candidates?: Array<{
    url?: string;
    metadataMatch?: { relation?: string; incidentCategories?: string[] };
  }>;
  excludedCandidates?: {
    total?: number;
    detailsWithheld?: boolean;
  };
}

const client = new Client({
  name: "property-articles-live-smoke-test",
  version: "1.0.0",
});

try {
  const testAddress =
    process.env.ARTICLE_SMOKE_ADDRESS?.trim() ||
    "Mannerheimintie 1 A 2, 00100 Helsinki";
  const expectedAddress = normalizeArticleAddress(testAddress).normalizedAddress;
  const env = getDefaultEnvironment();
  for (const key of [
    "ARTICLE_SEARCH_PROVIDER",
    "BRAVE_SEARCH_API_KEY",
    "BRAVE_SEARCH_BASE_URL",
    "GDELT_DOC_API_URL",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.ARTICLE_SEARCH_PROVIDER ??= "gdelt";

  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      env,
      stderr: "inherit",
    })
  );

  const response = await client.callTool({
    name: "search_property_incident_articles",
    arguments: {
      address: testAddress,
      categories: [
        "fire_rescue",
        "crime_police",
        "water_damage",
        "indoor_air_mold",
        "structural_risk",
      ],
      languages: ["fi", "en"],
      includeSameStreet: false,
      includeNeighborhood: false,
      limit: 3,
    },
  });
  const text = (response.content as Array<{ type: string; text?: string }>)
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  const data = JSON.parse(text) as SmokeResult;

  console.log(
    JSON.stringify({
      provider: data.provider?.provider,
      target: data.target,
      searchCoverage: data.searchCoverage,
      returnedCandidates: data.returnedCandidates,
      excludedCandidates: data.excludedCandidates,
    })
  );

  assert.equal(response.isError, undefined);
  assert.equal(data.target?.normalizedAddress, expectedAddress);
  const expectedQueryCount = data.provider?.provider === "brave" ? 10 : 2;
  assert.equal(data.searchCoverage?.queriesAttempted, expectedQueryCount);
  const succeeded = data.searchCoverage?.queriesSucceeded ?? 0;
  const failed = data.searchCoverage?.queriesFailed ?? 0;
  assert.equal(succeeded + failed, expectedQueryCount);
  if (failed > 0) {
    for (const query of data.searchCoverage?.queries ?? []) {
      if (query.error) {
        assert.match(
          query.error,
          /HTTP 429/,
          "Only an external GDELT rate limit may be tolerated by the live smoke test."
        );
      }
    }
  }
  assert.ok(
    (data.candidates ?? []).every((candidate) =>
      ["exact_address", "inflected_address"].includes(
        candidate.metadataMatch?.relation ?? ""
      )
    ),
    "Strict address search must not expose unverified, same-street or neighborhood candidates."
  );
  assert.equal(data.excludedCandidates?.detailsWithheld, true);
  if (process.env.ARTICLE_SMOKE_EXPECT_CANDIDATE === "true") {
    assert.ok(
      (data.returnedCandidates ?? 0) > 0,
      "The known-positive smoke address should expose at least one address-linked candidate."
    );
  }

  const expectedUrl = process.env.ARTICLE_SMOKE_EXPECT_URL?.trim();
  if (expectedUrl) {
    const expectedCandidate = (data.candidates ?? []).find(
      (candidate) => candidate.url === expectedUrl
    );
    assert.ok(
      expectedCandidate,
      `Expected article was not returned as a candidate: ${expectedUrl}`
    );

    const contextResponse = await client.callTool({
      name: "get_property_article_context",
      arguments: {
        url: expectedUrl,
        address: expectedAddress,
      },
    });
    const contextText = (
      contextResponse.content as Array<{ type: string; text?: string }>
    )
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    const context = JSON.parse(contextText) as {
      title?: string | null;
      verification?: { relation?: string; incidentCategories?: string[] } | null;
    };
    assert.equal(contextResponse.isError, undefined);
    assert.ok(
      ["exact_address", "inflected_address"].includes(
        context.verification?.relation ?? ""
      ),
      "Expected article must verify against the target address."
    );
    console.log(
      JSON.stringify({
        verifiedUrl: expectedUrl,
        title: context.title,
        verification: context.verification,
      })
    );
  }

} finally {
  await client.close();
}
