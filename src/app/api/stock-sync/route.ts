import { NextRequest, NextResponse } from "next/server";
import { prisma, getLocationId } from "@/lib/db";
import { getProductStock } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

// Cron job: Sync stock levels from ItScope to Shopify
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Starting stock sync...");

  // Get all active tracked products, grouped by shop
  const trackedProducts = await prisma.trackedProduct.findMany({
    where: { active: true },
  });

  const byShop = new Map<string, typeof trackedProducts>();
  for (const tp of trackedProducts) {
    const existing = byShop.get(tp.shop) || [];
    existing.push(tp);
    byShop.set(tp.shop, existing);
  }

  let updated = 0;
  let errors = 0;

  for (const [shop, products] of byShop) {
    const session = await getOfflineSession(shop);
    if (!session) {
      console.error(`No session for shop ${shop}, skipping`);
      errors += products.length;
      continue;
    }

    const client = await getShopifyClient(shop, session.accessToken!);

    for (const product of products) {
      try {
        if (!product.itscopeProductId) continue;
        if (product.productType === "Warranty") continue; // Warranties have no inventory

        // Fetch current stock from ItScope
        const offers = await getProductStock(product.itscopeProductId);
        const selectedOffer = offers.find(
          (o) => o.distributorId === product.distributorId
        );

        if (!selectedOffer) {
          console.warn(
            `No offer from distributor ${product.distributorId} for ${product.itscopeSku}`
          );
          continue;
        }

        const newStock = selectedOffer.stock;
        // Use project price if the product has a project ID with a matching project offer
        const projectMatch = product.projectId
          ? selectedOffer.projects.find((p) => p.manufacturerProjectId === product.projectId)
          : null;
        const newPrice = projectMatch?.price ?? selectedOffer.price;

        // Update Shopify inventory if we have the inventory item ID
        if (product.shopifyInventoryItemId) {
          const locationId = await getLocationId(product.shop, client);

          if (locationId) {
            // Ensure inventory is activated at this location
            try {
              await client.request(
                `mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
                  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                    inventoryLevel { id }
                    userErrors { field message }
                  }
                }`,
                {
                  variables: {
                    inventoryItemId: product.shopifyInventoryItemId,
                    locationId,
                  },
                }
              );
            } catch (activateError) {
              console.warn(`inventoryActivate failed for ${product.itscopeSku} (may already be active):`, activateError);
            }

            // Set inventory level
            console.log(`Setting inventory for ${product.itscopeSku}: itemId=${product.shopifyInventoryItemId}, locationId=${locationId}, qty=${newStock}`);
            const invResponse = await client.request(
              `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) {
                  inventoryAdjustmentGroup {
                    createdAt
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              {
                variables: {
                  input: {
                    name: "available",
                    reason: "correction",
                    ignoreCompareQuantity: true,
                    quantities: [
                      {
                        inventoryItemId: product.shopifyInventoryItemId,
                        locationId: locationId,
                        quantity: newStock,
                      },
                    ],
                  },
                },
              }
            );
            const invErrors = (invResponse as any).data?.inventorySetQuantities?.userErrors;
            if (invErrors?.length > 0) {
              console.error(`inventorySetQuantities errors for ${product.itscopeSku}:`, JSON.stringify(invErrors));
            }
          }
        }

        // Check if buy price increased (alert but don't auto-update Shopify prices)
        const referencePrice = product.importPrice ?? product.lastPrice ?? 0;
        const priceIncreased = newPrice > referencePrice;
        if (priceIncreased) {
          console.warn(`Price alert for ${product.itscopeSku}: was €${referencePrice.toFixed(2)}, now €${newPrice.toFixed(2)}`);
        }

        // Update tracking record (lastPrice tracks current ItScope price, NOT Shopify price)
        await prisma.trackedProduct.update({
          where: { id: product.id },
          data: {
            lastStock: newStock,
            lastPrice: newPrice,
            lastStockSync: new Date(),
            priceAlert: priceIncreased ? true : product.priceAlert,
          },
        });

        updated++;
      } catch (error) {
        console.error(`Stock sync error for ${product.itscopeSku}:`, error);
        errors++;
      }
    }
  }

  console.log(`Stock sync complete: ${updated} updated, ${errors} errors`);
  return NextResponse.json({ updated, errors });
}
