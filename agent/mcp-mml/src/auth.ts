export function getMmlAuthHeaders(): Record<string, string> {
  const apiKey = process.env.MML_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "MML_API_KEY is not configured. Add it to the root .env file before calling MML tools."
    );
  }

  const credentials = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return { Authorization: `Basic ${credentials}` };
}
