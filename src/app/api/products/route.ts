import { NextRequest, NextResponse } from "next/server";
import { prisma, getLocationId } from "@/lib/db";
import { searchProductBySku } from "@/lib/itscope";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

// GET - List all tracked products for a shop
export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop" }, { status: 400 });
  }

  const products = await prisma.trackedProduct.findMany({
    where: { shop, active: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(products);
}

// POST - Import a new product from ItScope to Shopify
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { shop, sku, distributorId, distributorName, shippingMode, projectId, productType, metafields } = body;
  const validTypes = ["Laptop", "Warranty", "Accessory"];
  const resolvedType = validTypes.includes(productType) ? productType : "Laptop";

  if (!shop || !sku || !distributorId) {
    return NextResponse.json(
      { error: "Missing required fields: shop, sku, distributorId" },
      { status: 400 }
    );
  }

  // Check if already tracked
  const existing = await prisma.trackedProduct.findUnique({
    where: { shop_itscopeSku: { shop, itscopeSku: sku } },
  });
  if (existing) {
    if (existing.active) {
      return NextResponse.json(
        { error: "Product already tracked", product: existing },
        { status: 409 }
      );
    }
    // Previously removed — delete the old record so we can re-import fresh
    await prisma.trackedProduct.delete({ where: { id: existing.id } });
  }

  // Fetch product data from ItScope
  const itscopeProduct = await searchProductBySku(sku);
  if (!itscopeProduct) {
    return NextResponse.json(
      { error: "Product not found in ItScope" },
      { status: 404 }
    );
  }

  // Get the selected distributor's offer
  const selectedOffer = itscopeProduct.offers.find(
    (o) => o.distributorId === distributorId
  );

  // Get Shopify session
  const session = await getOfflineSession(shop);
  if (!session) {
    return NextResponse.json(
      { error: "No Shopify session found. Please reinstall the app." },
      { status: 401 }
    );
  }

  const client = await getShopifyClient(shop, session.accessToken!);

  try {
    // Build metafields array for Shopify
    const shopifyMetafields = metafields
      ? Object.entries(metafields as Record<string, string>)
          .filter(([, value]) => value !== "" && value !== null && value !== undefined)
          .map(([key, value]) => {
            const [namespace, metafieldKey] = key.split(".");
            return {
              namespace,
              key: metafieldKey,
              value: String(value),
              type: "single_line_text_field",
            };
          })
      : [];

    // Map product type to tags
    const typeTag = resolvedType === "Warranty" ? "warranty" : resolvedType === "Accessory" ? "addon" : "laptop";

    // Step 1: Create the product (new API: no variants/images in ProductInput)
    const createProductResponse = await client.request(
      `mutation productCreate($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          product: {
            title: itscopeProduct.name,
            descriptionHtml: itscopeProduct.longDescription || itscopeProduct.shortDescription || `<p>${itscopeProduct.name}</p>`,
            vendor: itscopeProduct.manufacturer,
            productType: resolvedType,
            tags: ["itscope-managed", typeTag],
            status: "DRAFT",
            ...(shopifyMetafields.length > 0 ? { metafields: shopifyMetafields } : {}),
          },
        },
      }
    );

    // Check for GraphQL-level errors first
    const gqlErrors = (createProductResponse as any).errors;
    if (gqlErrors) {
      console.error("Shopify GraphQL errors:", JSON.stringify(gqlErrors));
    }

    let result = (createProductResponse as any).data?.productCreate;

    if (result?.userErrors?.length > 0) {
      console.error("Shopify productCreate userErrors:", JSON.stringify(result.userErrors));

      // If metafields caused the error, retry without them
      if (shopifyMetafields.length > 0) {
        console.warn("Retrying productCreate without metafields...");
        const retryResponse = await client.request(
          `mutation productCreate($product: ProductCreateInput!) {
            productCreate(product: $product) {
              product {
                id
                title
                variants(first: 1) {
                  edges {
                    node {
                      id
                      inventoryItem {
                        id
                      }
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              product: {
                title: itscopeProduct.name,
                descriptionHtml: itscopeProduct.longDescription || itscopeProduct.shortDescription || `<p>${itscopeProduct.name}</p>`,
                vendor: itscopeProduct.manufacturer,
                productType: resolvedType,
                tags: ["itscope-managed", typeTag],
                status: "DRAFT",
              },
            },
          }
        );

        const retryResult = (retryResponse as any).data?.productCreate;
        if (retryResult?.userErrors?.length > 0) {
          console.error("Shopify productCreate still failed without metafields:", JSON.stringify(retryResult.userErrors));
          return NextResponse.json(
            { error: "Shopify errors", details: retryResult.userErrors },
            { status: 422 }
          );
        }

        // Use the retry result
        result = retryResult;
        console.warn("Product created without metafields — check metafield definitions in Shopify admin");
      } else {
        return NextResponse.json(
          { error: "Shopify errors", details: result.userErrors },
          { status: 422 }
        );
      }
    }

    const shopifyProduct = result?.product;
    const productId = shopifyProduct?.id;

    // The default variant is auto-created; update it with SKU/price/barcode
    const defaultVariant = shopifyProduct?.variants?.edges?.[0]?.node;

    if (defaultVariant && productId) {
      const buyPrice = selectedOffer?.price || 0;
      const sellPrice = (buyPrice * 1.10).toFixed(2); // 10% margin
      const costPrice = buyPrice.toFixed(2);

      const variantUpdateResponse = await client.request(
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              inventoryItem {
                id
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            productId,
            variants: [
              {
                id: defaultVariant.id,
                price: sellPrice,
                barcode: itscopeProduct.ean || undefined,
                inventoryPolicy: "DENY",
                inventoryItem: {
                  sku: sku,
                  tracked: resolvedType !== "Warranty",
                  cost: costPrice,
                },
              },
            ],
          },
        }
      );

      const variantResult = (variantUpdateResponse as any).data?.productVariantsBulkUpdate;
      if (variantResult?.userErrors?.length > 0) {
        console.error("Variant update errors:", variantResult.userErrors);
      }

      // Update the variant reference with fresh data
      const updatedVariant = variantResult?.productVariants?.[0];
      if (updatedVariant) {
        defaultVariant.id = updatedVariant.id;
        defaultVariant.inventoryItem = updatedVariant.inventoryItem;
      }
    }

    // Step 3: Add product image if available
    if (itscopeProduct.imageUrl && productId) {
      try {
        await client.request(
          `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $productId, media: $media) {
              media {
                alt
              }
              mediaUserErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              productId,
              media: [
                {
                  originalSource: itscopeProduct.imageUrl,
                  alt: itscopeProduct.name,
                  mediaContentType: "IMAGE",
                },
              ],
            },
          }
        );
      } catch (imgError) {
        console.error("Image upload failed (non-fatal):", imgError);
      }
    }

    const variant = defaultVariant;

    // Step 4: Set initial inventory quantity (skip for warranties)
    const initialStock = selectedOffer?.stock ?? 0;
    if (resolvedType !== "Warranty" && variant?.inventoryItem?.id) {
      try {
        const locationId = await getLocationId(shop, client);

        if (locationId) {
          // Activate inventory at this location first
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
                  inventoryItemId: variant.inventoryItem.id,
                  locationId,
                },
              }
            );
          } catch (activateError) {
            console.warn("inventoryActivate failed (may already be active):", activateError);
          }

          // Now set the quantity
          await client.request(
            `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                userErrors { field message }
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
                      inventoryItemId: variant.inventoryItem.id,
                      locationId,
                      quantity: initialStock,
                    },
                  ],
                },
              },
            }
          );
        }
      } catch (stockError) {
        console.error("Initial stock set failed (non-fatal):", stockError);
      }
    }

    // Store the tracked product
    const createData = {
      shop,
      itscopeSku: sku,
      itscopeProductId: itscopeProduct.productId,
      shopifyProductId: shopifyProduct?.id,
      shopifyVariantId: variant?.id,
      shopifyInventoryItemId: variant?.inventoryItem?.id,
      distributorId,
      distributorName: distributorName || "",
      productType: resolvedType,
      shippingMode: shippingMode || "warehouse",
      projectId: projectId || null,
      importPrice: selectedOffer?.price || 0,
      lastPrice: selectedOffer?.price,
      lastStock: selectedOffer?.stock,
      lastStockSync: new Date(),
    };
    console.log("Prisma create data:", JSON.stringify(createData));
    const tracked = await prisma.trackedProduct.create({ data: createData });

    return NextResponse.json({ success: true, product: tracked });
  } catch (error: any) {
    console.error("Product creation error:", error?.name, error?.message);
    if (error?.meta) console.error("Prisma meta:", JSON.stringify(error.meta));
    return NextResponse.json(
      { error: error.message || "Failed to create product in Shopify" },
      { status: 500 }
    );
  }
}

// PATCH - Update a tracked product (e.g. projectId, dismiss price alert)
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { shop, id, projectId, dismissPriceAlert } = body;

  if (!shop || !id) {
    return NextResponse.json(
      { error: "Missing shop or id" },
      { status: 400 }
    );
  }

  const updateData: Record<string, any> = {};
  if (projectId !== undefined) updateData.projectId = projectId || null;
  if (dismissPriceAlert) updateData.priceAlert = false;

  const updated = await prisma.trackedProduct.update({
    where: { id: Number(id) },
    data: updateData,
  });

  return NextResponse.json({ success: true, product: updated });
}

// DELETE - Remove a tracked product
export async function DELETE(request: NextRequest) {
  const { shop, id } = await request.json();

  if (!shop || !id) {
    return NextResponse.json(
      { error: "Missing shop or id" },
      { status: 400 }
    );
  }

  await prisma.trackedProduct.update({
    where: { id: Number(id) },
    data: { active: false },
  });

  return NextResponse.json({ success: true });
}
