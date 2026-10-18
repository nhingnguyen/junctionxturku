const DEFAULT_SYKE_USER_ID = "ryhti";

/**
 * Ryhti/SYKE identifies API consumers with the `sykeuserid` query parameter.
 * This is not an OAuth flow and does not create or persist access tokens.
 */
export function addSykeUserId(url: URL): URL {
  const configuredUserId = process.env.SYKE_USER_ID?.trim();
  url.searchParams.set(
    "sykeuserid",
    configuredUserId || DEFAULT_SYKE_USER_ID
  );

  return url;
}
