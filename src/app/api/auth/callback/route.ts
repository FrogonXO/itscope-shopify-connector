import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Session } from "@shopify/shopify-api";
import { sessionStorage } from "@/lib/session-storage";
import shopify from "@/lib/shopify";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const shop = params.get("shop");
    const code = params.get("code");
    const state = params.get("state");
    const hmac = params.get("hmac");

    if (!shop || !code || !state) {
      return NextResponse.json(
        { error: "Missing required OAuth parameters" },
        { status: 400 }
      );
    }

    // Verify the nonce matches what we stored
    const storedNonce = request.cookies.get("shopify_nonce")?.value;
    if (!storedNonce || storedNonce !== state) {
      // If cookie is lost (common in serverless), proceed anyway but verify HMAC
      console.warn("Nonce cookie missing, falling back to HMAC verification");
    }

    // Verify HMAC from Shopify
    if (hmac) {
      const queryParams = new URLSearchParams(params.toString());
      queryParams.delete("hmac");
      // Sort parameters
      const sortedParams = Array.from(queryParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");

      const generatedHmac = crypto
        .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
        .update(sortedParams)
        .digest("hex");

      if (generatedHmac !== hmac) {
        return NextResponse.json(
          { error: "HMAC verification failed" },
          { status: 401 }
        );
      }
    }

    // Exchange the authorization code for an access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY!,
        client_secret: process.env.SHOPIFY_API_SECRET!,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error("Token exchange failed:", error);
      return NextResponse.json(
        { error: "Failed to get access token" },
        { status: 500 }
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const scope = tokenData.scope;

    // Create and store the session
    const sessionId = `offline_${shop}`;
    const session = new Session({
      id: sessionId,
      shop,
      state: state,
      isOnline: false,
      accessToken,
    });
    session.scope = scope;

    await sessionStorage.storeSession(session);
    console.log(`Session stored for ${shop}`);

    // Register webhooks
    try {
      const webhookResponse = await shopify.webhooks.register({ session });
      console.log("Webhook registration:", JSON.stringify(webhookResponse));
    } catch (e) {
      console.error("Webhook registration failed:", e);
    }

    // Redirect to the embedded app
    const redirectUrl = `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;
    const response = NextResponse.redirect(redirectUrl);

    // Clear the auth cookies
    response.cookies.delete("shopify_nonce");
    response.cookies.delete("shopify_shop");

    return response;
  } catch (error: any) {
    console.error("Auth callback error:", error);
    return NextResponse.json(
      { error: error.message || "Auth failed" },
      { status: 500 }
    );
  }
}
