import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

// GET - Fetch current settings and available locations
export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop" }, { status: 400 });
  }

  const session = await getOfflineSession(shop);
  if (!session) {
    return NextResponse.json(
      { error: "No Shopify session found" },
      { status: 401 }
    );
  }

  const client = await getShopifyClient(shop, session.accessToken!);

  // Fetch all locations from Shopify
  const locationsResponse = await client.request(
    `query {
      locations(first: 50) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }`
  );

  const locations = ((locationsResponse as any).data?.locations?.edges || [])
    .map((e: any) => e.node)
    .filter((l: any) => l.isActive);

  // Get current settings
  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
  });

  return NextResponse.json({
    locations,
    selectedLocationId: settings?.locationId || null,
  });
}

// POST - Save settings
export async function POST(request: NextRequest) {
  const { shop, locationId } = await request.json();

  if (!shop || !locationId) {
    return NextResponse.json(
      { error: "Missing shop or locationId" },
      { status: 400 }
    );
  }

  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: { locationId },
    create: { shop, locationId },
  });

  return NextResponse.json({ success: true, settings });
}
