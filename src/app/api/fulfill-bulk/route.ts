import { NextRequest, NextResponse } from "next/server";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

interface BulkFulfillRow {
  kundenbestellnummer: string;
  sendungsnummer: string;
  herstellerArtikelnummer: string;
  stueck: number;
  artikelbezeichnung: string;
  seriennummer: string;
  rowIndex: number;
}

interface RowResult {
  rowIndex: number;
  orderName: string;
  sku: string;
  status: "success" | "error" | "skipped";
  message: string;
}

export async function POST(request: NextRequest) {
  const { shop, rows, dryRun } = await request.json();

  if (!shop || !rows || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "Missing shop or rows" }, { status: 400 });
  }

  const session = await getOfflineSession(shop);
  if (!session) {
    return NextResponse.json({ error: "No Shopify session found" }, { status: 401 });
  }

  const client = await getShopifyClient(shop, session.accessToken!);
  const results: RowResult[] = [];

  // Group rows by order name to handle multiple line items per order
  const byOrder = new Map<string, BulkFulfillRow[]>();
  for (const row of rows) {
    const key = row.kundenbestellnummer.trim();
    const existing = byOrder.get(key) || [];
    existing.push(row);
    byOrder.set(key, existing);
  }

  for (const [orderName, orderRows] of byOrder) {
    try {
      // Find order in Shopify
      const searchResult = await client.request(
        `query findOrder($query: String!) {
          orders(first: 1, query: $query) {
            edges {
              node {
                id
                name
                fulfillmentOrders(first: 10) {
                  nodes {
                    id
                    status
                    lineItems(first: 50) {
                      nodes {
                        id
                        remainingQuantity
                        lineItem {
                          sku
                          variant { sku }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { variables: { query: `name:${orderName}` } }
      );

      const orderNode = (searchResult as any).data?.orders?.edges?.[0]?.node;
      if (!orderNode) {
        for (const row of orderRows) {
          results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "error", message: `Order "${orderName}" not found in Shopify` });
        }
        continue;
      }

      // Group by tracking number — each tracking number gets its own fulfillment
      const byTracking = new Map<string, BulkFulfillRow[]>();
      for (const row of orderRows) {
        // DPD Austria tracking numbers are 14 digits — fix missing leading zero
        let trackingNum = row.sendungsnummer.trim();
        if (/^\d{13}$/.test(trackingNum)) {
          trackingNum = "0" + trackingNum;
        }
        row.sendungsnummer = trackingNum;
        const key = trackingNum;
        const existing = byTracking.get(key) || [];
        existing.push(row);
        byTracking.set(key, existing);
      }

      // Collect serial numbers for this order
      const serialNumbers: string[] = [];

      for (const [trackingNumber, trackingRows] of byTracking) {
        // Find fulfillment order line items to fulfill
        const lineItemsToFulfill: { fulfillmentOrderId: string; items: { id: string; quantity: number }[] }[] = [];

        for (const row of trackingRows) {
          let matched = false;

          for (const fo of orderNode.fulfillmentOrders.nodes) {
            if (fo.status !== "OPEN" && fo.status !== "IN_PROGRESS") continue;

            for (const foli of fo.lineItems.nodes) {
              const foliSku = foli.lineItem?.sku || foli.lineItem?.variant?.sku || "";
              if (foliSku !== row.herstellerArtikelnummer) continue;
              if (foli.remainingQuantity <= 0) {
                results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "skipped", message: `Already fulfilled (remainingQuantity=0)` });
                matched = true;
                break;
              }

              // Add to fulfillment items
              let foGroup = lineItemsToFulfill.find((g) => g.fulfillmentOrderId === fo.id);
              if (!foGroup) {
                foGroup = { fulfillmentOrderId: fo.id, items: [] };
                lineItemsToFulfill.push(foGroup);
              }
              foGroup.items.push({ id: foli.id, quantity: Math.min(row.stueck, foli.remainingQuantity) });
              matched = true;

              if (row.seriennummer) {
                serialNumbers.push(row.seriennummer);
              }

              break;
            }
            if (matched) break;
          }

          if (!matched) {
            results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "error", message: `SKU "${row.herstellerArtikelnummer}" not found in order or no open fulfillment order` });
          }
        }

        if (lineItemsToFulfill.length === 0) continue;

        if (dryRun) {
          // Dry run — report what would happen without actually fulfilling
          for (const row of trackingRows) {
            if (!results.some((r) => r.rowIndex === row.rowIndex)) {
              results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "success", message: `[DRY RUN] Would fulfill with DPD tracking ${trackingNumber}${row.seriennummer ? `, serial: ${row.seriennummer}` : ""}` });
            }
          }
          continue;
        }

        // Create fulfillment with DPD tracking
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
                lineItemsByFulfillmentOrder: lineItemsToFulfill.map((g) => ({
                  fulfillmentOrderId: g.fulfillmentOrderId,
                  fulfillmentOrderLineItems: g.items,
                })),
                notifyCustomer: true,
                trackingInfo: {
                  company: "DPD",
                  number: trackingNumber,
                  url: "https://www.mydpd.at/meine-pakete",
                },
              },
            },
          }
        );

        const fulfillResult = (fulfillmentResult as any).data?.fulfillmentCreate;
        const errors = fulfillResult?.userErrors || [];

        if (errors.length > 0) {
          for (const row of trackingRows) {
            if (!results.some((r) => r.rowIndex === row.rowIndex)) {
              results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "error", message: `Fulfillment error: ${errors.map((e: any) => e.message).join(", ")}` });
            }
          }
        } else {
          for (const row of trackingRows) {
            if (!results.some((r) => r.rowIndex === row.rowIndex)) {
              results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "success", message: `Fulfilled with DPD tracking ${trackingNumber}` });
            }
          }
        }
      }

      // Write serial numbers to order metafield (skip in dry run)
      if (serialNumbers.length > 0 && !dryRun) {
        try {
          // Read existing metafield value first
          const metafieldResult = await client.request(
            `query getMetafield($id: ID!) {
              order(id: $id) {
                metafield(namespace: "custom", key: "serial_number") {
                  value
                }
              }
            }`,
            { variables: { id: orderNode.id } }
          );

          const existingValue = (metafieldResult as any).data?.order?.metafield?.value || "";
          const existingSerials = existingValue ? existingValue.split(", ").filter(Boolean) : [];
          const allSerials = [...existingSerials, ...serialNumbers];
          const serialValue = allSerials.join(", ");

          await client.request(
            `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                metafields: [{
                  ownerId: orderNode.id,
                  namespace: "custom",
                  key: "serial_number",
                  type: "single_line_text_field",
                  value: serialValue,
                }],
              },
            }
          );
        } catch (e) {
          console.error(`Failed to write serial numbers for ${orderName}:`, e);
        }
      }

      // Small delay between orders to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 300));

    } catch (error: any) {
      for (const row of orderRows) {
        if (!results.some((r) => r.rowIndex === row.rowIndex)) {
          results.push({ rowIndex: row.rowIndex, orderName, sku: row.herstellerArtikelnummer, status: "error", message: `Unexpected error: ${error.message || error}` });
        }
      }
    }
  }

  // Sort results by rowIndex
  results.sort((a, b) => a.rowIndex - b.rowIndex);

  return NextResponse.json({ results });
}
