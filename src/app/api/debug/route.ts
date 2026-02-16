import { NextRequest, NextResponse } from "next/server";

// Debug endpoint to test ItScope API connectivity directly
export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get("sku") || "4Y50R20863";

  const accountId = process.env.ITSCOPE_ACCOUNT_ID;
  const apiKey = process.env.ITSCOPE_API_KEY;

  if (!accountId || !apiKey) {
    return NextResponse.json({
      error: "Missing ITSCOPE_ACCOUNT_ID or ITSCOPE_API_KEY env vars",
      hasAccountId: !!accountId,
      hasApiKey: !!apiKey,
    });
  }

  const credentials = Buffer.from(`${accountId}:${apiKey}`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    "User-Agent": "ItScopeShopifyConnector-App-1.0",
    Accept: "application/xml",
  };

  // Test 1: Basic API connectivity with a simple search
  const testUrl = `https://api.itscope.com/2.1/products/search/hstpid=${encodeURIComponent(sku)}/standard.xml`;

  try {
    const response = await fetch(testUrl, { headers });
    const body = await response.text();

    return NextResponse.json({
      testUrl,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      bodyPreview: body.substring(0, 2000),
      bodyLength: body.length,
    });
  } catch (error: any) {
    return NextResponse.json({
      testUrl,
      error: error.message,
    });
  }
}
