import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCustomerId } from "@/lib/distributors";
import { buildOrderXml, sendOrder, searchProductBySku } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

interface LogEntry {
  time: string;
  level: "info" | "error" | "success";
  message: string;
}

function log(logs: LogEntry[], level: LogEntry["level"], message: string) {
  logs.push({ time: new Date().toISOString(), level, message });
}

export async function POST(request: NextRequest) {
  if (process.env.DISABLE_WEBHOOKS === "true") {
    return NextResponse.json({ success: false, logs: [{ time: new Date().toISOString(), level: "error", message: "System is currently disabled (DISABLE_WEBHOOKS=true)" }] });
  }

  const { shop, orderNumber } = await request.json();
  const logs: LogEntry[] = [];

  if (!shop || !orderNumber) {
    return NextResponse.json({ error: "Missing shop or orderNumber", logs }, { status: 400 });
  }

  try {
    log(logs, "info", `Looking up order "${orderNumber}" in Shopify...`);

    // Get Shopify session
    const session = await getOfflineSession(shop);
    if (!session) {
      log(logs, "error", "No Shopify session found for this shop");
      return NextResponse.json({ success: false, logs });
    }

    const client = await getShopifyClient(shop, session.accessToken!);

    // Search for the order by name/number in Shopify
    const searchResult = await client.request(
      `query findOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              displayFulfillmentStatus
              displayFinancialStatus
              cancelledAt
              createdAt
              email
              phone
              customer { firstName lastName email phone }
              shippingAddress {
                firstName lastName company
                address1 address2 city zip countryCodeV2 phone
              }
              billingAddress {
                firstName lastName company
                address1 address2 city zip countryCodeV2 phone
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    vendor
                    sku
                    variant { id sku }
                    product { id }
                  }
                }
              }
              fulfillmentOrders(first: 10) {
                nodes {
                  status
                  deliveryMethod { methodType }
                }
              }
            }
          }
        }
      }`,
      { variables: { query: `name:${orderNumber}` } }
    );

    const orderNode = (searchResult as any).data?.orders?.edges?.[0]?.node;
    if (!orderNode) {
      log(logs, "error", `Order "${orderNumber}" not found in Shopify`);
      return NextResponse.json({ success: false, logs });
    }

    log(logs, "info", `Found order ${orderNode.name} (${orderNode.id})`);
    log(logs, "info", `Fulfillment status: ${orderNode.displayFulfillmentStatus}`);

    // Block cancelled or refunded orders
    const financialStatus = orderNode.displayFinancialStatus || "";
    log(logs, "info", `Financial status: ${financialStatus}`);
    if (orderNode.cancelledAt) {
      log(logs, "error", "Order is CANCELLED — cannot resend");
      return NextResponse.json({ success: false, logs });
    }
    if (["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(financialStatus)) {
      log(logs, "error", `Order is ${financialStatus} — cannot resend to prevent double orders`);
      return NextResponse.json({ success: false, logs });
    }

    // Check fulfillment status — don't resend if already fulfilled
    if (orderNode.displayFulfillmentStatus === "FULFILLED") {
      log(logs, "error", "Order is already FULFILLED — cannot resend to prevent double orders");
      return NextResponse.json({ success: false, logs });
    }

    // Check fulfillment holds and delivery method
    const fulfillmentNodes = orderNode.fulfillmentOrders?.nodes || [];
    const holdStatuses = fulfillmentNodes.map((fo: any) => fo.status);
    const deliveryMethods = fulfillmentNodes.map((fo: any) => fo.deliveryMethod?.methodType).filter(Boolean);
    log(logs, "info", `Fulfillment order statuses: ${JSON.stringify(holdStatuses)}`);
    if (holdStatuses.includes("ON_HOLD")) {
      log(logs, "error", "Order is still ON_HOLD — waiting for verification release");
      return NextResponse.json({ success: false, logs });
    }

    const isLocalPickup = deliveryMethods.some((m: string) => m === "PICK_UP" || m === "LOCAL");
    if (isLocalPickup) {
      log(logs, "info", "Local pickup order — will use warehouse (company) address for delivery");
    }

    // Extract numeric order ID from GID
    const shopifyOrderGid = orderNode.id;
    const numericOrderId = shopifyOrderGid.replace("gid://shopify/Order/", "");

    // Match line items to tracked products
    const lineItems = orderNode.lineItems.edges.map((e: any) => e.node);
    log(logs, "info", `Order has ${lineItems.length} line items`);

    // Match by variant ID only (no product ID fallback — it causes wrong matches for multi-variant products)
    const variantGids = lineItems
      .map((li: any) => li.variant?.id)
      .filter(Boolean);

    const trackedProducts = await prisma.trackedProduct.findMany({
      where: { shop, shopifyVariantId: { in: variantGids }, active: true },
    });

    log(logs, "info", `Matched ${trackedProducts.length} tracked products by variant`);

    // For unmatched line items, check ItScope for Target Distribution availability (even "Nicht verfügbar")
    const trackedVariantGids = new Set(trackedProducts.map((tp) => tp.shopifyVariantId));
    const unmatchedLineItems = lineItems.filter(
      (li: any) => li.variant?.id && !trackedVariantGids.has(li.variant.id)
    );

    // Synthetic tracked product entries for unmatched items found on Target
    const targetFallbackProducts: typeof trackedProducts = [];
    // Track if any unmatched AppleCare items are found (for remarks)
    let hasUnmatchedAppleCare = false;

    if (unmatchedLineItems.length > 0) {
      log(logs, "info", `${unmatchedLineItems.length} unmatched line items — checking ItScope for Target Distribution...`);

      for (const li of unmatchedLineItems) {
        // AppleCare warranties are not ordered as line items — noted in remarks instead
        if ((li.title || "").toLowerCase().includes("applecare")) {
          hasUnmatchedAppleCare = true;
          log(logs, "info", `"${li.title}" is AppleCare — will add to remarks, not ordered as line item`);
          continue;
        }

        const sku = li.sku || li.variant?.sku;
        if (!sku) {
          log(logs, "info", `Skipping "${li.title}" — no SKU available`);
          continue;
        }

        log(logs, "info", `Searching ItScope for SKU "${sku}"...`);
        const itscopeProduct = await searchProductBySku(sku);
        if (!itscopeProduct) {
          log(logs, "info", `SKU "${sku}" not found on ItScope`);
          continue;
        }

        // Find Target Distribution offer with exact SKU match
        const targetOffer = itscopeProduct.offers.find(
          (o) => o.distributorName.toLowerCase().includes("target") && o.supplierSKU === sku
        );

        if (!targetOffer) {
          log(logs, "error", `SKU "${sku}" found on ItScope but no Target Distribution offer with matching supplierSKU. Available Target offers: ${itscopeProduct.offers.filter(o => o.distributorName.toLowerCase().includes("target")).map(o => `${o.supplierSKU} (price=${o.price})`).join(", ") || "none"}`);
          continue;
        }

        if (!targetOffer.price || targetOffer.price <= 0) {
          log(logs, "error", `Target offer for "${sku}" has no price (price=${targetOffer.price}). Check ItScope individual pricing for Target Distribution.`);
          continue;
        }

        log(logs, "info", `Found Target offer for "${sku}": SKU=${targetOffer.supplierSKU}, status="${targetOffer.stockStatusText}", price=${targetOffer.price}, priceCalc=${targetOffer.priceCalc}, projects=${JSON.stringify(targetOffer.projects)}`);

        // Create a synthetic tracked product entry for this unmatched item
        targetFallbackProducts.push({
          id: `target-fallback-${sku}`,
          shop,
          itscopeSku: sku,
          itscopeProductId: itscopeProduct.productId,
          shopifyProductId: li.product?.id || "",
          shopifyVariantId: li.variant?.id || "",
          shopifyProductTitle: li.title || null,
          distributorId: targetOffer.distributorId,
          distributorName: targetOffer.distributorName,
          distributorSku: targetOffer.supplierSKU,
          shippingMode: "dropship",
          productType: null,
          projectId: null,
          lastPrice: targetOffer.price || null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
      }
    }

    const allProducts = [...trackedProducts, ...targetFallbackProducts];

    if (allProducts.length === 0) {
      log(logs, "error", "No tracked ItScope products found in this order and no Target fallback available");
      return NextResponse.json({ success: false, logs });
    }

    // Group by distributor
    const byDistributor = new Map<string, typeof trackedProducts>();
    for (const tp of allProducts) {
      const existing = byDistributor.get(tp.distributorId) || [];
      existing.push(tp);
      byDistributor.set(tp.distributorId, existing);
    }

    const distributorEntries = Array.from(byDistributor.entries());
    const baseOrderId = orderNode.name.replace("#", "");

    let anySuccess = false;

    for (let i = 0; i < distributorEntries.length; i++) {
      const [distributorId, products] = distributorEntries[i];
      const ownOrderId = (i > 0 ? `${baseOrderId}/${i}` : baseOrderId).substring(0, 18);
      const distributorLabel = products[0]?.distributorName || distributorId;

      log(logs, "info", `--- Processing distributor: ${distributorLabel} (order ID: ${ownOrderId}) ---`);

      // Check for existing DB record — delete old error/pending records so we can retry
      const existingDbOrder = await prisma.order.findFirst({
        where: { shop, shopifyOrderId: shopifyOrderGid, distributorId },
      });

      if (existingDbOrder) {
        if (existingDbOrder.status === "sent") {
          log(logs, "info", `Already sent to ${distributorLabel} (Deal-ID: ${existingDbOrder.itscopeDealId}), skipping`);
          continue;
        }
        // Delete error/pending records so we can retry
        log(logs, "info", `Deleting previous ${existingDbOrder.status} record to retry`);
        await prisma.order.delete({ where: { id: existingDbOrder.id } });
      }

      // Create new pending record
      // Local pickup → always warehouse (deliver to our company address, not customer)
      const isDropship = isLocalPickup ? false : products.some((p) => p.shippingMode === "dropship");
      const dbOrder = await prisma.order.create({
        data: {
          shop,
          shopifyOrderId: shopifyOrderGid,
          shopifyOrderNumber: baseOrderId,
          itscopeOwnOrderId: ownOrderId,
          distributorId,
          status: "pending",
          dropship: isDropship,
        },
      });

      // Build line items
      const orderLineItems = products
        .map((tp) => {
          const lineItem = lineItems.find(
            (li: any) =>
              tp.shopifyVariantId && li.variant?.id === tp.shopifyVariantId
          );
          if (!lineItem) return null;

          if (!tp.distributorSku) {
            log(logs, "error", `SKIPPED: No distributor SKU for "${tp.itscopeSku}" — relink this product to fetch the distributor SKU before retrying.`);
            return null;
          }

          return {
            supplierPid: tp.distributorSku,
            itscopeProductId: tp.itscopeProductId || "",
            quantity: lineItem.quantity,
            description: lineItem.title || tp.itscopeSku,
            projectId: tp.projectId || undefined,
            unitPrice: tp.lastPrice || undefined,
            productType: tp.productType === "Warranty" ? ("service" as const) : undefined,
          };
        })
        .filter(Boolean) as any[];

      if (orderLineItems.length === 0) {
        log(logs, "error", `No matching line items for ${distributorLabel}`);
        await prisma.order.delete({ where: { id: dbOrder.id } });
        continue;
      }

      log(logs, "info", `Line items: ${orderLineItems.map((li: any) => `${li.supplierPid} x${li.quantity}`).join(", ")}`);

      // Build shipping/billing info from GraphQL data
      const shippingAddress = orderNode.shippingAddress || orderNode.billingAddress || {};
      const billingAddress = orderNode.billingAddress || shippingAddress;

      // Check for service items needing licensee info
      const hasServiceItems = orderLineItems.some((li: any) => li.productType);
      const customerParty = hasServiceItems
        ? {
            company: billingAddress.company || `${billingAddress.firstName || ""} ${billingAddress.lastName || ""}`.trim(),
            firstName: billingAddress.firstName || orderNode.customer?.firstName || "",
            lastName: billingAddress.lastName || orderNode.customer?.lastName || "",
            email: orderNode.email || orderNode.customer?.email || "",
            phone: billingAddress.phone || orderNode.customer?.phone || orderNode.phone || "",
            street: `${billingAddress.address1 || ""}${billingAddress.address2 ? " " + billingAddress.address2 : ""}`,
            zip: billingAddress.zip || "",
            city: billingAddress.city || "",
            country: billingAddress.countryCodeV2 || "DE",
          }
        : undefined;

      // Apple-specific remarks
      const getVendor = (tp: typeof products[0]) => {
        const li = lineItems.find((li: any) => li.variant?.id === tp.shopifyVariantId);
        return (li?.vendor || "").toLowerCase();
      };
      const hasAppleProduct = products.some((p) => p.productType !== "Warranty" && getVendor(p) === "apple");
      const hasAppleCareTracked = hasAppleProduct && products.some(
        (p) => p.productType === "Warranty" && getVendor(p) === "apple"
      );

      // Remove tracked Apple warranty line items — they are noted in remarks instead
      if (hasAppleCareTracked) {
        const warrantyIndices = orderLineItems
          .map((li: any, idx: number) => {
            const tp = products.find((p) => p.distributorSku === li.supplierPid);
            return tp?.productType === "Warranty" && getVendor(tp) === "apple" ? idx : -1;
          })
          .filter((idx: number) => idx >= 0)
          .reverse();
        for (const idx of warrantyIndices) {
          orderLineItems.splice(idx, 1);
        }
        log(logs, "info", "Apple warranty removed from line items — added to remarks as 'AppleCare+ dazubuchen'");
      }

      // AppleCare detected either from tracked products or from unmatched line items
      const hasAppleCare = hasAppleCareTracked || (hasAppleProduct && hasUnmatchedAppleCare);

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
              deliveryCompany: `${shippingAddress.firstName || ""} ${shippingAddress.lastName || ""}`.trim() || shippingAddress.company,
              deliveryName: shippingAddress.company || "",
              deliveryStreet: `${shippingAddress.address1 || ""}${shippingAddress.address2 ? " " + shippingAddress.address2 : ""}`,
              deliveryZip: shippingAddress.zip || "",
              deliveryCity: shippingAddress.city || "",
              deliveryCountry: shippingAddress.countryCodeV2 || "DE",
              deliveryContactName: `${shippingAddress.firstName || ""} ${shippingAddress.lastName || ""}`.trim() || shippingAddress.company || "",
              deliveryContactEmail: orderNode.email || orderNode.customer?.email || "",
              deliveryPhone: shippingAddress.phone || orderNode.customer?.phone || "",
            }
          : {}),
        customerParty,
        lineItems: orderLineItems,
        remarks,
      });

      log(logs, "info", `Sending order to ItScope for ${distributorLabel}...`);
      const result = await sendOrder(distributorId, orderXml);

      // Update DB record
      await prisma.order.update({
        where: { id: dbOrder.id },
        data: {
          itscopeDealId: result.dealId || null,
          status: result.success ? "sent" : "error",
          errorMessage: result.error || null,
        },
      });

      if (result.success) {
        log(logs, "success", `Order sent successfully to ${distributorLabel}! Deal-ID: ${result.dealId || "N/A"}`);
        anySuccess = true;

        // Add Shopify comment
        await addOrderComment(
          client,
          shopifyOrderGid,
          `[Manual Resend] ItScope order ${ownOrderId} sent to ${distributorLabel}${isDropship ? " (Dropship)" : " (Warehouse)"}. ${result.dealId ? `Deal-ID: ${result.dealId}` : ""}`
        );
      } else {
        log(logs, "error", `Failed to send to ${distributorLabel}: ${result.error}`);

        await addOrderComment(
          client,
          shopifyOrderGid,
          `[Manual Resend] ItScope order ${ownOrderId} failed for ${distributorLabel}: ${result.error?.substring(0, 200) || "Unknown"}`
        );
      }
    }

    return NextResponse.json({ success: anySuccess, logs });
  } catch (error: any) {
    log(logs, "error", `Unexpected error: ${error.message || error}`);
    return NextResponse.json({ success: false, logs });
  }
}

async function addOrderComment(client: any, orderId: string, message: string) {
  try {
    await client.request(
      `mutation addComment($id: ID!, $message: String!) {
        orderUpdate(input: { id: $id, note: $message }) {
          order { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: orderId, message } }
    );
  } catch (e) {
    console.error("Failed to add order comment:", e);
  }
}
