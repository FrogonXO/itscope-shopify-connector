import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDealStatus, fetchDispatchDocument } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

// Cron job: Check ItScope order statuses and update Shopify
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Starting order status sync...");

  // Get all non-final orders (use itscopeDealId or itscopeOwnOrderId)
  const pendingOrders = await prisma.order.findMany({
    where: {
      status: { in: ["sent", "confirmed"] },
    },
  });

  let updated = 0;
  let errors = 0;

  for (const order of pendingOrders) {
    try {
      // Use itscopeDealId if available, otherwise fall back to our own order ID
      const lookupId = order.itscopeDealId || order.itscopeOwnOrderId;
      if (!lookupId) continue;

      // Check deal status in ItScope
      console.log(`Checking status for order ${order.id}, lookupId: ${lookupId}`);
      const dealStatus = await getDealStatus(lookupId);
      if (!dealStatus) continue;

      let newStatus = order.status;
      let trackingNumber = order.trackingNumber;
      let serialNumbers = order.serialNumbers;

      // Map ItScope status to our status
      const itscopeStatus = dealStatus.status.toUpperCase();
      if (itscopeStatus.includes("CONFIRMED") || itscopeStatus.includes("ADVISED")) {
        newStatus = "confirmed";
      }
      if (itscopeStatus.includes("SHIPPED") || itscopeStatus.includes("DISPATCHED")) {
        newStatus = "shipped";
      }
      if (itscopeStatus.includes("DELIVERED") || itscopeStatus.includes("COMPLETED")) {
        newStatus = "delivered";
      }

      // If dispatch notification is available, fetch tracking and serials
      if (dealStatus.dispatchDocumentUrl) {
        const dispatchInfo = await fetchDispatchDocument(
          dealStatus.dispatchDocumentUrl
        );

        if (dispatchInfo.trackingNumbers.length > 0) {
          trackingNumber = dispatchInfo.trackingNumbers[0];
        }
        if (dispatchInfo.serialNumbers.length > 0) {
          serialNumbers = JSON.stringify(dispatchInfo.serialNumbers);
        }
      }

      // If we have a tracking number and the order hasn't been fulfilled in Shopify yet
      if (trackingNumber && newStatus === "shipped" && order.status !== "shipped") {
        await createShopifyFulfillment(
          order.shop,
          order.shopifyOrderId,
          trackingNumber,
          serialNumbers ? JSON.parse(serialNumbers) : []
        );
      }

      // Update order record
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: newStatus,
          trackingNumber,
          serialNumbers,
          lastStatusCheck: new Date(),
        },
      });

      if (newStatus !== order.status) {
        updated++;
      }
    } catch (error) {
      console.error(`Order status sync error for order ${order.id}:`, error);
      errors++;
    }
  }

  console.log(`Order status sync complete: ${updated} updated, ${errors} errors`);
  return NextResponse.json({ updated, errors });
}

async function createShopifyFulfillment(
  shop: string,
  shopifyOrderId: string,
  trackingNumber: string,
  serialNumbers: string[]
) {
  const session = await getOfflineSession(shop);
  if (!session) {
    console.error(`No session for shop ${shop}`);
    return;
  }

  const client = await getShopifyClient(shop, session.accessToken!);

  try {
    // Get fulfillment order ID
    const orderResponse = await client.request(
      `query getOrder($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 5) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      remainingQuantity
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { id: shopifyOrderId } }
    );

    const fulfillmentOrders =
      (orderResponse as any).data?.order?.fulfillmentOrders?.edges || [];

    for (const { node: fo } of fulfillmentOrders) {
      if (fo.status !== "OPEN") continue;

      const lineItems = fo.lineItems.edges
        .filter((e: any) => e.node.remainingQuantity > 0)
        .map((e: any) => ({ id: e.node.id, quantity: e.node.remainingQuantity }));

      if (lineItems.length === 0) continue;

      // Create fulfillment with tracking
      const notifyCustomer = true;
      const fulfillmentResult = await client.request(
        `mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
            fulfillment {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            fulfillment: {
              lineItemsByFulfillmentOrder: [
                {
                  fulfillmentOrderId: fo.id,
                  fulfillmentOrderLineItems: lineItems,
                },
              ],
              notifyCustomer,
              trackingInfo: {
                number: trackingNumber,
              },
            },
          },
        }
      );

      const result = (fulfillmentResult as any).data?.fulfillmentCreate;
      if (result?.userErrors?.length > 0) {
        console.error("Fulfillment errors:", result.userErrors);
      } else {
        console.log(`Fulfillment created for order ${shopifyOrderId}`);
      }
    }

    // Add serial numbers as order note if available
    if (serialNumbers.length > 0) {
      await client.request(
        `mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
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
              id: shopifyOrderId,
              note: `Serial Numbers: ${serialNumbers.join(", ")}`,
            },
          },
        }
      );
    }
  } catch (error) {
    console.error("Fulfillment creation error:", error);
    throw error;
  }
}
