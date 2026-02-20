// Allowed distributors and their ItScope customer numbers (Kundennummer)
export const DISTRIBUTORS = [
  { name: "TD Synnex Austria", pattern: "synnex", customerId: "640545" },
  { name: "ALSO Österreich", pattern: "also", customerId: "10738286" },
  { name: "Ingram Micro Österreich", pattern: "ingram", customerId: "AT28198920" },
  { name: "Target Distribution", pattern: "target", customerId: "59803" },
] as const;

/** Get the buyer customer ID (Kundennummer) for a distributor */
export function getCustomerId(distributorName: string): string | undefined {
  const lower = distributorName.toLowerCase();
  return DISTRIBUTORS.find((d) => lower.includes(d.pattern))?.customerId;
}

/** Check if a distributor is in our allowed list */
export function isAllowedDistributor(distributorName: string): boolean {
  const lower = distributorName.toLowerCase();
  return DISTRIBUTORS.some((d) => lower.includes(d.pattern));
}
