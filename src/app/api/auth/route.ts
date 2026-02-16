import { NextRequest, NextResponse } from "next/server";
import shopify from "@/lib/shopify";

export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Begin OAuth flow
  const authRoute = await shopify.auth.begin({
    shop,
    callbackPath: "/api/auth/callback",
    isOnline: false,
    rawRequest: request,
  });

  return NextResponse.redirect(authRoute);
}
