import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { buildOrderXml, sendOrder } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

export async function POST(request: NextRequest) {
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
        await handleOrderCreated(shop, body);
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

async function handleOrderCreated(shop: string, order: any) {
  console.log(`New order ${order.id} from ${shop}`);

  // Check which line items are ItScope-managed products
  const lineItems = order.line_items || [];
  const shopifyProductIds = lineItems
    .map((item: any) => String(item.product_id))
    .filter(Boolean);

  if (shopifyProductIds.length === 0) return;

  // Find tracked products that match
  const trackedProducts = await prisma.trackedProduct.findMany({
    where: {
      shop,
      shopifyProductId: { in: shopifyProductIds.map((id: string) => `gid://shopify/Product/${id}`) },
      active: true,
    },
  });

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

  for (const [distributorId, products] of byDistributor) {
    // Check if any product in this distributor group uses dropshipping
    const isDropship = products.some((p) => p.shippingMode === "dropship");

    // Build line items for this distributor
    const orderLineItems = products
      .map((tp) => {
        const lineItem = lineItems.find(
          (li: any) =>
            `gid://shopify/Product/${li.product_id}` === tp.shopifyProductId
        );
        if (!lineItem) return null;
        return {
          supplierPid: tp.itscopeSku,
          itscopeProductId: tp.itscopeProductId || "",
          quantity: lineItem.quantity,
          description: lineItem.title || tp.itscopeSku,
          projectId: tp.projectId || undefined,
          unitPrice: tp.lastPrice || undefined,
        };
      })
      .filter(Boolean) as any[];

    if (orderLineItems.length === 0) continue;

    // Generate a unique order ID (max 18 chars)
    const ownOrderId = `SH${order.order_number}`.substring(0, 18);

    const orderXml = buildOrderXml({
      orderId: ownOrderId,
      supplierId: distributorId,
      dropship: isDropship,
      buyerPartyId: process.env.ITSCOPE_ACCOUNT_ID!,
      buyerCompany: process.env.COMPANY_NAME || "My Company",
      buyerStreet: process.env.COMPANY_STREET || "",
      buyerZip: process.env.COMPANY_ZIP || "",
      buyerCity: process.env.COMPANY_CITY || "",
      buyerCountry: process.env.COMPANY_COUNTRY || "DE",
      ...(isDropship
        ? {
            deliveryCompany: `${shippingAddress.first_name || ""} ${shippingAddress.last_name || ""}`.trim() || shippingAddress.company,
            deliveryName: shippingAddress.company || "",
            deliveryStreet: `${shippingAddress.address1 || ""}${shippingAddress.address2 ? " " + shippingAddress.address2 : ""}`,
            deliveryZip: shippingAddress.zip || "",
            deliveryCity: shippingAddress.city || "",
            deliveryCountry: shippingAddress.country_code || "DE",
          }
        : {}),
      lineItems: orderLineItems,
      remarks: `Shopify Order #${order.order_number}`,
    });

    // Log the generated XML for debugging
    console.log(`Order XML for ${ownOrderId}:`, orderXml);
    console.log(`Buyer address: company="${process.env.COMPANY_NAME}", street="${process.env.COMPANY_STREET}", zip="${process.env.COMPANY_ZIP}", city="${process.env.COMPANY_CITY}", country="${process.env.COMPANY_COUNTRY}"`);

    // Send order to ItScope
    const result = await sendOrder(distributorId, orderXml);

    // Store order mapping in database
    await prisma.order.create({
      data: {
        shop,
        shopifyOrderId: `gid://shopify/Order/${order.id}`,
        shopifyOrderNumber: String(order.order_number),
        itscopeDealId: result.dealId || null,
        itscopeOwnOrderId: ownOrderId,
        distributorId,
        status: result.success ? "sent" : "error",
        errorMessage: result.error || null,
        dropship: isDropship,
      },
    });

    if (result.success) {
      console.log(
        `Order sent to ItScope: ${ownOrderId} -> Deal ${result.dealId}`
      );
    } else {
      console.error(`Failed to send order ${ownOrderId}: ${result.error}`);
    }
  }
}

async function handleAppUninstalled(shop: string) {
  // Clean up sessions when app is uninstalled
  await prisma.session.deleteMany({ where: { shop } });
  console.log(`App uninstalled from ${shop}, sessions cleaned up`);
}
