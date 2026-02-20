import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { getCustomerId } from "@/lib/distributors";
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

  // Pre-compute deterministic order IDs for each distributor before any processing
  // This ensures IDs stay stable across webhook retries regardless of skip order
  const distributorEntries = Array.from(byDistributor.entries());
  const baseOrderId = `SH${order.order_number}`;
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
    const isDropship = products.some((p) => p.shippingMode === "dropship");
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
          productType: tp.productType === "Warranty" ? "service" as const : undefined,
        };
      })
      .filter(Boolean) as any[];

    if (orderLineItems.length === 0) {
      await prisma.order.delete({ where: { id: dbOrder.id } });
      continue;
    }

    // Check if this order contains warranty/service items that need licensee info
    const hasServiceItems = orderLineItems.some((li: any) => li.productType);

    // Extract end customer (licensee) info from Shopify order for warranty items
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
      const li = lineItems.find((li: any) => `gid://shopify/Product/${li.product_id}` === tp.shopifyProductId);
      return (li?.vendor || "").toLowerCase();
    };
    const hasAppleProduct = products.some((p) => getVendor(p) === "apple");
    const hasAppleCare = hasAppleProduct && products.some(
      (p) => p.productType === "Warranty" && getVendor(p) === "apple"
    );
    const remarks = hasAppleCare
      ? "Universität Wien + AppleCare+"
      : hasAppleProduct
        ? "Universität Wien"
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
