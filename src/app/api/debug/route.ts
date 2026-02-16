import { NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

// Debug endpoint to test ItScope API connectivity directly
export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get("sku") || "4Y50R20863";
  const full = request.nextUrl.searchParams.get("full") === "true";

  const accountId = process.env.ITSCOPE_ACCOUNT_ID;
  const apiKey = process.env.ITSCOPE_API_KEY;

  if (!accountId || !apiKey) {
    return NextResponse.json({
      error: "Missing ITSCOPE_ACCOUNT_ID or ITSCOPE_API_KEY env vars",
    });
  }

  const credentials = Buffer.from(`${accountId}:${apiKey}`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    "User-Agent": "ItScopeShopifyConnector-App-1.0",
    Accept: "application/xml",
  };

  // Fetch with plzproducts=true to get price lines
  const testUrl = `https://api.itscope.com/2.1/products/search/hstpid=${encodeURIComponent(sku)}/standard.xml?plzproducts=true`;

  try {
    const response = await fetch(testUrl, { headers });
    const body = await response.text();

    // Parse the XML to see the actual structure
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
    });
    const parsed = parser.parse(body);

    // Show the full parsed structure so we can map fields correctly
    const product = parsed?.products?.product;
    const firstProduct = Array.isArray(product) ? product[0] : product;

    return NextResponse.json({
      testUrl,
      status: response.status,
      xmlKeys: firstProduct ? Object.keys(firstProduct) : [],
      parsedProduct: full ? firstProduct : undefined,
      productSample: firstProduct
        ? {
            puid: firstProduct.puid,
            ean: firstProduct.ean,
            manufacturerSKU: firstProduct.manufacturerSKU,
            productName: firstProduct.productName,
            manufacturerName: firstProduct.manufacturerName,
            shortDescription: firstProduct.shortDescription,
            longDescription: firstProduct.longDescription?.substring(0, 200),
            // Check for price/offer related fields
            priceRelatedKeys: Object.keys(firstProduct).filter(
              (k) =>
                k.toLowerCase().includes("price") ||
                k.toLowerCase().includes("offer") ||
                k.toLowerCase().includes("stock") ||
                k.toLowerCase().includes("avail") ||
                k.toLowerCase().includes("supplier") ||
                k.toLowerCase().includes("distri") ||
                k.toLowerCase().includes("plz")
            ),
          }
        : null,
      bodyPreview: body.substring(0, 3000),
    });
  } catch (error: any) {
    return NextResponse.json({ testUrl, error: error.message });
  }
}
