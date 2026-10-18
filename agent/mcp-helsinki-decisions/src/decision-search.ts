export type DualPassStage = "pass_1_parcel_id" | "pass_2_address";

export interface DualPassSearchPlan {
  stage: DualPassStage;
  query: string;
  phrase: true;
}

export function quoteExactPhrase(value: string): string {
  const phrase = value.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  if (!phrase) throw new Error("Exact phrase search value cannot be empty.");
  return `"${phrase}"`;
}

/** Exactly two searches: one cadastral identifier and one official address. */
export function buildDualPassSearchPlans(
  parcelIdentifier: string,
  officialAddress: string
): [DualPassSearchPlan, DualPassSearchPlan] {
  return [
    {
      stage: "pass_1_parcel_id",
      query: quoteExactPhrase(parcelIdentifier),
      phrase: true,
    },
    {
      stage: "pass_2_address",
      query: quoteExactPhrase(officialAddress),
      phrase: true,
    },
  ];
}

/**
 * Keeps limited output representative of both discovery passes. Input order is
 * expected to already reflect confidence/date ranking within each group.
 */
export function selectDualPassResults<
  T extends { foundByPasses: DualPassStage[] },
>(items: T[], limit: number): T[] {
  const selected: T[] = [];
  const seen = new Set<T>();
  const both = items.filter(
    (item) =>
      item.foundByPasses.includes("pass_1_parcel_id") &&
      item.foundByPasses.includes("pass_2_address")
  );
  const parcelOnly = items.filter(
    (item) =>
      item.foundByPasses.includes("pass_1_parcel_id") &&
      !item.foundByPasses.includes("pass_2_address")
  );
  const addressOnly = items.filter(
    (item) =>
      item.foundByPasses.includes("pass_2_address") &&
      !item.foundByPasses.includes("pass_1_parcel_id")
  );

  const add = (item: T | undefined) => {
    if (!item || selected.length >= limit || seen.has(item)) return;
    selected.push(item);
    seen.add(item);
  };

  let parcelStart = 0;
  if (both[0]) {
    add(both[0]);
  } else {
    add(parcelOnly[0]);
    parcelStart = 1;
  }
  add(addressOnly[0]);

  for (let index = 0; selected.length < limit; index++) {
    const previousLength = selected.length;
    add(both[index + 1]);
    add(parcelOnly[index + parcelStart]);
    add(addressOnly[index + 1]);
    if (selected.length === previousLength) break;
  }
  for (const item of items) add(item);

  return selected;
}
