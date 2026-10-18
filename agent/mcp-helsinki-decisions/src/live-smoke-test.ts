import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

interface SmokeResult {
  resolutionStatus?: string;
  parcelContext?: {
    kiinteistotunnus?: string;
    officialAddress?: string;
  };
  searchExecution?: {
    exactPassCount?: number;
    passes?: Array<{ query?: string; phraseType?: boolean }>;
  };
  returnedDecisions?: number;
  matchSummary?: Record<string, number>;
}

const client = new Client({
  name: "helsinki-decisions-live-smoke-test",
  version: "1.0.0",
});

try {
  const env = getDefaultEnvironment();
  for (const key of ["HELSINKI_DECISIONS_API_URL", "PARCEL_DATA_PATH"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      env,
      stderr: "inherit",
    })
  );

  const response = await client.callTool({
    name: "helsinki_search_parcel_decisions",
    arguments: {
      address: "Veturitie 1 A 2",
      language: "fi",
      limit: 3,
    },
  });
  const text = (response.content as Array<{ type: string; text?: string }>)
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  const data = JSON.parse(text) as SmokeResult;

  assert.equal(response.isError, undefined);
  assert.equal(data.resolutionStatus, "resolved");
  assert.equal(data.parcelContext?.kiinteistotunnus, "09143200010026");
  assert.equal(data.parcelContext?.officialAddress, "Veturitie 1");
  assert.equal(data.searchExecution?.exactPassCount, 2);
  assert.equal(data.searchExecution?.passes?.length, 2);
  assert.ok(
    data.searchExecution?.passes?.every(
      (pass) =>
        pass.phraseType === true &&
        pass.query?.startsWith('"') &&
        pass.query.endsWith('"')
    )
  );

  console.log(
    JSON.stringify({
      resolutionStatus: data.resolutionStatus,
      parcelContext: data.parcelContext,
      searchExecution: data.searchExecution,
      returnedDecisions: data.returnedDecisions,
      matchSummary: data.matchSummary,
    })
  );
} finally {
  await client.close();
}
