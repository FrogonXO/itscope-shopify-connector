import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { getCustomerId } from "@/lib/distributors";
import { buildOrderXml, sendOrder } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

export async function POST(request: NextRequest) {
  // Kill switch: set DISABLE_WEBHOOKS=true in Vercel env to stop all processing
  if (process.env.DISABLE_WEBHOOKS === "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const topic = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain");
  const hmac = request.headers.get("x-shopify-hmac-sha256");

  if (!topic || !shop || !hmac) {
    return NextResponse.json({ error: "Missing headers" }, { status: 401 });
  }

  // Verify webhook authenticity
  const rawBody = await request.text();
  const hash = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(rawBody)
    .digest("base64");

  if (hash !== hmac) {
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  try {
    switch (topic) {
      case "orders/create":
        // Don't process immediately — a Shopify Flow puts the order on hold first
        // for student verification. We wait for orders/updated to detect hold release.
        console.log(`Order ${body.id} created from ${shop}, waiting for hold release`);
        break;
      case "orders/updated":
        await handleOrderUpdated(shop, body);
        break;
      case "app/uninstalled":
        await handleAppUninstalled(shop);
        break;
      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }
  } catch (error) {
    console.error(`Webhook error (${topic}):`, error);
  }

  // Always return 200 to acknowledge receipt
  return NextResponse.json({ ok: true });
}

async function handleOrderUpdated(shop: string, order: any) {
  console.log(`Order ${order.id} updated from ${shop}`);

  // Skip orders that are cancelled or in any refund state — these should never trigger new ItScope orders
  const financialStatus = order.financial_status || "";
  const cancelledAt = order.cancelled_at;
  if (cancelledAt || ["refunded", "partially_refunded", "voided"].includes(financialStatus)) {
    console.log(`Order ${order.id} is ${cancelledAt ? "cancelled" : financialStatus}, skipping`);
    return;
  }

  // Check fulfillment holds, delivery method, and live financial status via Shopify GraphQL
  // (webhook payload financial_status can be stale during refund processing)
  const { hasHold, isLocalPickup, isCancelledOrRefunded } = await checkFulfillmentInfo(shop, order.id);
  if (isCancelledOrRefunded) {
    console.log(`Order ${order.id} is cancelled/refunded (confirmed via GraphQL), skipping`);
    return;
  }
  if (hasHold) {
    console.log(`Order ${order.id} still on hold, skipping`);
    return;
  }

  if (isLocalPickup) {
    console.log(`Order ${order.id} is local pickup — will use warehouse (company) address for delivery`);
  }

  // Guard against race condition: orders/updated fires before the Flow puts the order on hold.
  // If the order was created less than 90 seconds ago and has no hold, the Flow hasn't acted yet.
  // When the hold is eventually released, orders/updated will fire again and we'll process it then.
  const orderAge = Date.now() - new Date(order.created_at).getTime();
  if (orderAge < 90_000) {
    console.log(`Order ${order.id} is only ${Math.round(orderAge / 1000)}s old with no hold, waiting for Flow to act`);
    return;
  }

  // Only process UNFULFILLED line items — skip items already shipped
  const allLineItems = order.line_items || [];
  const lineItems = allLineItems.filter(
    (item: any) => !item.fulfillment_status || item.fulfillment_status === "partial"
  );

  if (lineItems.length === 0) {
    console.log(`Order ${order.id} has no unfulfilled line items, skipping`);
    return;
  }

  console.log(`Order ${order.id} line items: ${allLineItems.length} total, ${lineItems.length} unfulfilled`);

  // Match unfulfilled line items to tracked products by variant ID only
  // (no product ID fallback — it causes wrong matches for multi-variant products)
  const shopifyVariantIds = lineItems
    .map((item: any) => String(item.variant_id))
    .filter((id: string) => id && id !== "null" && id !== "undefined");

  if (shopifyVariantIds.length === 0) return;

  const variantGids = shopifyVariantIds.map((id: string) => `gid://shopify/ProductVariant/${id}`);

  const trackedProducts = await prisma.trackedProduct.findMany({
    where: {
      shop,
      shopifyVariantId: { in: variantGids },
      active: true,
    },
  });

  console.log(`Order ${order.id} matched ${trackedProducts.length} tracked products by variant`);

  if (trackedProducts.length === 0) return;

  // Group line items by distributor
  const byDistributor = new Map<string, typeof trackedProducts>();
  for (const tp of trackedProducts) {
    const existing = byDistributor.get(tp.distributorId) || [];
    existing.push(tp);
    byDistributor.set(tp.distributorId, existing);
  }

  // Get shipping address from the order
  const shippingAddress = order.shipping_address || order.billing_address || {};

  // Pre-compute deterministic order IDs for each distributor before any processing
  // This ensures IDs stay stable across webhook retries regardless of skip order
  const distributorEntries = Array.from(byDistributor.entries());
  const baseOrderId = (order.name || `${order.order_number}`).replace("#", "");
  const orderIdMap = new Map<string, string>();
  for (let i = 0; i < distributorEntries.length; i++) {
    const [distId] = distributorEntries[i];
    const ownOrderId = i > 0
      ? `${baseOrderId}/${i}`.substring(0, 18)
      : baseOrderId.substring(0, 18);
    orderIdMap.set(distId, ownOrderId);
  }

  for (const [distributorId, products] of distributorEntries) {
    const ownOrderId = orderIdMap.get(distributorId)!;
    try {
    // Claim this order slot in the DB with "pending" status BEFORE sending to ItScope.
    // The unique constraint [shop, shopifyOrderId, distributorId] acts as a lock —
    // if a concurrent webhook already claimed it, the create will throw and we skip.
    // Local pickup → always warehouse (deliver to our company address, not customer)
    const isDropship = isLocalPickup ? false : products.some((p) => p.shippingMode === "dropship");
    let dbOrder;
    try {
      dbOrder = await prisma.order.create({
        data: {
          shop,
          shopifyOrderId: `gid://shopify/Order/${order.id}`,
          shopifyOrderNumber: String(order.order_number),
          itscopeOwnOrderId: ownOrderId,
          distributorId,
          status: "pending",
          dropship: isDropship,
        },
      });
    } catch (e: any) {
      // Unique constraint violation = already claimed by another webhook
      if (e?.code === "P2002") {
        console.log(`Order ${order.id} already claimed for distributor ${distributorId}, skipping`);
        continue;
      }
      throw e;
    }

    // Build line items for this distributor
    const orderLineItems = products
      .map((tp) => {
        const lineItem = lineItems.find(
          (li: any) =>
            tp.shopifyVariantId && `gid://shopify/ProductVariant/${li.variant_id}` === tp.shopifyVariantId
        );
        if (!lineItem) return null;
        if (!tp.distributorSku) {
          console.error(`Order ${order.id}: No distributor SKU for "${tp.itscopeSku}" — skipping item. Relink product to fix.`);
          return null;
        }
        return {
          supplierPid: tp.distributorSku,
          itscopeProductId: tp.itscopeProductId || "",
          quantity: lineItem.quantity,
          description: lineItem.title || tp.itscopeSku,
          projectId: tp.projectId || undefined,
          unitPrice: tp.lastPrice || undefined,
          productType: tp.productType === "Warranty" ? "service" as const : undefined,
        };
      })
      .filter(Boolean) as any[];

    if (orderLineItems.length === 0) {
      // All items skipped (likely missing distributor SKU) — record the error
      const skippedSkus = products.filter(p => !p.distributorSku).map(p => p.itscopeSku);
      if (skippedSkus.length > 0) {
        const errorMsg = `Distributor SKU missing for: ${skippedSkus.join(", ")}. Relink these products and resend manually.`;
        await prisma.order.update({
          where: { id: dbOrder.id },
          data: { status: "error", errorMessage: errorMsg },
        });
        await addOrderComment(shop, `gid://shopify/Order/${order.id}`, `ItScope order ${ownOrderId} failed for ${products[0]?.distributorName || distributorId}: ${errorMsg}`);
      } else {
        await prisma.order.delete({ where: { id: dbOrder.id } });
      }
      continue;
    }

    // Check if this order contains warranty/service items that need licensee info
    // (Apple warranties are excluded from line items and noted in remarks instead,
    //  but non-Apple warranties still need ENDCUSTOMER party)
    const hasServiceItems = orderLineItems.some((li: any) => li.productType);

    const billingAddress = order.billing_address || shippingAddress;
    const customerParty = hasServiceItems ? {
      company: billingAddress.company || `${billingAddress.first_name || ""} ${billingAddress.last_name || ""}`.trim(),
      firstName: billingAddress.first_name || order.customer?.first_name || "",
      lastName: billingAddress.last_name || order.customer?.last_name || "",
      email: order.email || order.customer?.email || "",
      phone: billingAddress.phone || order.customer?.phone || order.phone || "",
      street: `${billingAddress.address1 || ""}${billingAddress.address2 ? " " + billingAddress.address2 : ""}`,
      zip: billingAddress.zip || "",
      city: billingAddress.city || "",
      country: billingAddress.country_code || "DE",
    } : undefined;

    // Apple-specific remarks: check if any line item in this group is from Apple
    const getVendor = (tp: typeof products[0]) => {
      const li = lineItems.find((li: any) =>
        tp.shopifyVariantId && `gid://shopify/ProductVariant/${li.variant_id}` === tp.shopifyVariantId
      );
      return (li?.vendor || "").toLowerCase();
    };
    const hasAppleProduct = products.some((p) => p.productType !== "Warranty" && getVendor(p) === "apple");
    const hasAppleCare = hasAppleProduct && products.some(
      (p) => p.productType === "Warranty" && getVendor(p) === "apple"
    );

    // Remove Apple warranty line items from the order — they are noted in remarks instead
    if (hasAppleCare) {
      const warrantyIndices = orderLineItems
        .map((li: any, idx: number) => {
          const tp = products.find((p) => p.distributorSku === li.supplierPid || p.itscopeSku === li.supplierPid);
          return tp?.productType === "Warranty" && getVendor(tp) === "apple" ? idx : -1;
        })
        .filter((idx: number) => idx >= 0)
        .reverse();
      for (const idx of warrantyIndices) {
        orderLineItems.splice(idx, 1);
      }
    }

    const appleRemarks = "Universität Wien\nStudent\nUniversitätsring 1\n1010 Wien";
    const remarks = hasAppleCare
      ? appleRemarks + "\nAppleCare+ dazubuchen"
      : hasAppleProduct
        ? appleRemarks
        : undefined;

    const orderXml = buildOrderXml({
      orderId: ownOrderId,
      supplierId: distributorId,
      dropship: isDropship,
      buyerPartyId: getCustomerId(products[0]?.distributorName || "") || process.env.ITSCOPE_CUSTOMER_ID || process.env.ITSCOPE_ACCOUNT_ID!,
      buyerCompany: process.env.COMPANY_NAME || "My Company",
      buyerStreet: process.env.COMPANY_STREET || "",
      buyerZip: process.env.COMPANY_ZIP || "",
      buyerCity: process.env.COMPANY_CITY || "",
      buyerCountry: process.env.COMPANY_COUNTRY || "DE",
      buyerPhone: process.env.COMPANY_PHONE || undefined,
      buyerFax: process.env.COMPANY_FAX || undefined,
      buyerUrl: process.env.COMPANY_URL || undefined,
      buyerContactName: process.env.COMPANY_CONTACT_NAME || undefined,
      buyerContactEmail: process.env.COMPANY_CONTACT_EMAIL || undefined,
      buyerVatId: process.env.COMPANY_VAT_ID || undefined,
      ...(isDropship
        ? {
            deliveryCompany: `${shippingAddress.first_name || ""} ${shippingAddress.last_name || ""}`.trim() || shippingAddress.company,
            deliveryName: shippingAddress.company || "",
            deliveryStreet: `${shippingAddress.address1 || ""}${shippingAddress.address2 ? " " + shippingAddress.address2 : ""}`,
            deliveryZip: shippingAddress.zip || "",
            deliveryCity: shippingAddress.city || "",
            deliveryCountry: shippingAddress.country_code || "DE",
            deliveryContactName: `${shippingAddress.first_name || ""} ${shippingAddress.last_name || ""}`.trim() || shippingAddress.company || "",
            deliveryContactEmail: order.email || order.customer?.email || "",
            deliveryPhone: shippingAddress.phone || order.customer?.phone || "",
          }
        : {}),
      customerParty,
      lineItems: orderLineItems,
      remarks,
    });

    // Send order to ItScope
    const result = await sendOrder(distributorId, orderXml);

    // Update the pending DB record with the result
    await prisma.order.update({
      where: { id: dbOrder.id },
      data: {
        itscopeDealId: result.dealId || null,
        status: result.success ? "sent" : "error",
        errorMessage: result.error || null,
      },
    });

    // Add comment to Shopify order timeline
    const shopifyOrderGid = `gid://shopify/Order/${order.id}`;
    const distributorLabel = products[0]?.distributorName || distributorId;
    const productNames = orderLineItems.map((li: any) => li.description).join(", ");

    if (result.success) {
      console.log(
        `Order sent to ItScope: ${ownOrderId} -> Deal ${result.dealId}`
      );
      await addOrderComment(
        shop,
        shopifyOrderGid,
        `ItScope order ${ownOrderId} sent successfully to ${distributorLabel}${isDropship ? " (Dropship)" : " (Warehouse)"}. Products: ${productNames}.${result.dealId ? ` Deal-ID: ${result.dealId}` : ""}`
      );
    } else {
      console.error(`Failed to send order ${ownOrderId}: ${result.error}`);
      await addOrderComment(
        shop,
        shopifyOrderGid,
        `ItScope order ${ownOrderId} failed to send to ${distributorLabel}. Error: ${result.error?.substring(0, 200) || "Unknown error"}`
      );
    }
    } catch (distributorError) {
      console.error(`Error processing distributor ${distributorId} for order ${order.id}:`, distributorError);
    }
  }
}

async function checkFulfillmentInfo(shop: string, orderId: number): Promise<{ hasHold: boolean; isLocalPickup: boolean; isCancelledOrRefunded: boolean }> {
  try {
    const session = await getOfflineSession(shop);
    if (!session) return { hasHold: true, isLocalPickup: false, isCancelledOrRefunded: false };

    const client = await getShopifyClient(shop, session.accessToken!);
    const result = await client.request(
      `query fulfillmentInfo($orderId: ID!) {
        order(id: $orderId) {
          displayFinancialStatus
          cancelledAt
          fulfillmentOrders(first: 10) {
            nodes {
              status
              deliveryMethod {
                methodType
              }
            }
          }
        }
      }`,
      {
        variables: {
          orderId: `gid://shopify/Order/${orderId}`,
        },
      }
    );

    const orderData = (result as any).data?.order;
    const fulfillmentOrders = orderData?.fulfillmentOrders?.nodes || [];
    const statuses = fulfillmentOrders.map((fo: any) => fo.status);
    const deliveryMethods = fulfillmentOrders.map((fo: any) => fo.deliveryMethod?.methodType).filter(Boolean);
    const financialStatus = orderData?.displayFinancialStatus || "";
    const cancelledAt = orderData?.cancelledAt;

    console.log(`Fulfillment info for order ${orderId}: statuses=${JSON.stringify(statuses)}, deliveryMethods=${JSON.stringify(deliveryMethods)}, financialStatus=${financialStatus}, cancelledAt=${cancelledAt}`);

    const hasHold = fulfillmentOrders.some((fo: any) => fo.status === "ON_HOLD");
    const isLocalPickup = deliveryMethods.some((m: string) => m === "PICK_UP" || m === "LOCAL");
    const isCancelledOrRefunded = !!cancelledAt || ["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(financialStatus);

    return { hasHold, isLocalPickup, isCancelledOrRefunded };
  } catch (error) {
    console.error("Failed to check fulfillment info:", error);
    return { hasHold: true, isLocalPickup: false, isCancelledOrRefunded: false };
  }
}

async function addOrderComment(shop: string, orderId: string, message: string) {
  try {
    const session = await getOfflineSession(shop);
    if (!session) return;

    const client = await getShopifyClient(shop, session.accessToken!);

    // Update the order note
    const result = await client.request(
      `mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            note
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
            id: orderId,
            note: message,
          },
        },
      }
    );

    const errors = (result as any).data?.orderUpdate?.userErrors;
    if (errors?.length > 0) {
      console.error("Order comment errors:", errors);
    }
  } catch (error) {
    console.error("Failed to add order comment:", error);
  }
}

async function handleAppUninstalled(shop: string) {
  // Clean up sessions when app is uninstalled
  await prisma.session.deleteMany({ where: { shop } });
  console.log(`App uninstalled from ${shop}, sessions cleaned up`);
}
