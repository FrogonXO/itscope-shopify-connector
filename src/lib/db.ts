import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Get the stored location ID for a shop, or fall back to querying Shopify for the first location
export async function getLocationId(shop: string, client: any): Promise<string | null> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (settings?.locationId) return settings.locationId;

  // Fallback: get first location from Shopify
  const locationsResponse = await client.request(
    `query { locations(first: 1) { edges { node { id } } } }`
  );
  return (locationsResponse as any).data?.locations?.edges?.[0]?.node?.id || null;
}
