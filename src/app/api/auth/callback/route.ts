import { NextRequest, NextResponse } from "next/server";
import shopify from "@/lib/shopify";
import { sessionStorage } from "@/lib/session-storage";

export async function GET(request: NextRequest) {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: request,
    });

    const { session } = callback;

    // Store the session
    await sessionStorage.storeSession(session);

    // Register webhooks
    const webhookResponse = await shopify.webhooks.register({
      session,
    });
    console.log("Webhook registration:", JSON.stringify(webhookResponse));

    // Redirect to the embedded app
    const host = request.nextUrl.searchParams.get("host") || "";
    const redirectUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;

    return NextResponse.redirect(redirectUrl);
  } catch (error: any) {
    console.error("Auth callback error:", error);
    return NextResponse.json(
      { error: error.message || "Auth failed" },
      { status: 500 }
    );
  }
}
