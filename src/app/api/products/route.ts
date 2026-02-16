import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
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
  const { shop, sku, distributorId, distributorName, shippingMode } = body;

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
    return NextResponse.json(
      { error: "Product already tracked", product: existing },
      { status: 409 }
    );
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
            productType: "IT Product",
            tags: ["itscope-managed"],
          },
        },
      }
    );

    const result = (createProductResponse as any).data?.productCreate;

    if (result?.userErrors?.length > 0) {
      return NextResponse.json(
        { error: "Shopify errors", details: result.userErrors },
        { status: 422 }
      );
    }

    const shopifyProduct = result?.product;
    const productId = shopifyProduct?.id;

    // The default variant is auto-created; update it with SKU/price/barcode
    const defaultVariant = shopifyProduct?.variants?.edges?.[0]?.node;

    if (defaultVariant && productId) {
      const variantPrice = selectedOffer?.price ? String(selectedOffer.price) : "0.00";

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
                price: variantPrice,
                barcode: itscopeProduct.ean || undefined,
                inventoryPolicy: "DENY",
                inventoryItem: {
                  sku: sku,
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

    // Store the tracked product
    const tracked = await prisma.trackedProduct.create({
      data: {
        shop,
        itscopeSku: sku,
        itscopeProductId: itscopeProduct.productId,
        shopifyProductId: shopifyProduct?.id,
        shopifyVariantId: variant?.id,
        shopifyInventoryItemId: variant?.inventoryItem?.id,
        distributorId,
        distributorName: distributorName || "",
        shippingMode: shippingMode || "warehouse",
        lastPrice: selectedOffer?.price,
        lastStock: selectedOffer?.stock,
        lastStockSync: new Date(),
      },
    });

    return NextResponse.json({ success: true, product: tracked });
  } catch (error: any) {
    console.error("Product creation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create product in Shopify" },
      { status: 500 }
    );
  }
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
