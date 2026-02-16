import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Validate shop domain
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return NextResponse.json({ error: "Invalid shop domain" }, { status: 400 });
  }

  // Generate a random nonce for CSRF protection
  const nonce = crypto.randomBytes(16).toString("hex");

  const apiKey = process.env.SHOPIFY_API_KEY!;
  const scopes = process.env.SHOPIFY_SCOPES!;
  const appUrl = process.env.SHOPIFY_APP_URL!;
  const redirectUri = `${appUrl}/api/auth/callback`;

  // Build the Shopify OAuth authorization URL
  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${apiKey}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  // Store the nonce in a cookie so we can verify it in the callback
  const response = NextResponse.redirect(authUrl);
  response.cookies.set("shopify_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: 600, // 10 minutes
  });
  response.cookies.set("shopify_shop", shop, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: 600,
  });

  return response;
}
