import { NextRequest, NextResponse } from "next/server";
import { getOfflineSession } from "@/lib/session-storage";
import { getShopifyClient } from "@/lib/shopify";

// Register webhooks via GraphQL (more reliable than library method)
export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  try {
    const session = await getOfflineSession(shop);
    if (!session) {
      return NextResponse.json(
        { error: "No Shopify session found. Please reinstall the app." },
        { status: 401 }
      );
    }

    const client = await getShopifyClient(shop, session.accessToken!);
    const appUrl = process.env.SHOPIFY_APP_URL!;
    const results: any[] = [];

    // Register ORDERS_CREATE webhook
    const ordersResult = await client.request(
      `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            topic
            endpoint {
              ... on WebhookHttpEndpoint {
                callbackUrl
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
          topic: "ORDERS_CREATE",
          webhookSubscription: {
            callbackUrl: `${appUrl}/api/webhooks`,
            format: "JSON",
          },
        },
      }
    );
    results.push({
      topic: "ORDERS_CREATE",
      result: (ordersResult as any).data?.webhookSubscriptionCreate,
    });

    // Register ORDERS_UPDATED webhook (triggers ItScope order after hold release)
    const ordersUpdatedResult = await client.request(
      `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            topic
            endpoint {
              ... on WebhookHttpEndpoint {
                callbackUrl
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
          topic: "ORDERS_UPDATED",
          webhookSubscription: {
            callbackUrl: `${appUrl}/api/webhooks`,
            format: "JSON",
          },
        },
      }
    );
    results.push({
      topic: "ORDERS_UPDATED",
      result: (ordersUpdatedResult as any).data?.webhookSubscriptionCreate,
    });

    // Register APP_UNINSTALLED webhook
    const uninstallResult = await client.request(
      `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            topic
            endpoint {
              ... on WebhookHttpEndpoint {
                callbackUrl
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
          topic: "APP_UNINSTALLED",
          webhookSubscription: {
            callbackUrl: `${appUrl}/api/webhooks`,
            format: "JSON",
          },
        },
      }
    );
    results.push({
      topic: "APP_UNINSTALLED",
      result: (uninstallResult as any).data?.webhookSubscriptionCreate,
    });

    // Also list existing webhooks to confirm
    const listResult = await client.request(
      `query {
        webhookSubscriptions(first: 10) {
          edges {
            node {
              id
              topic
              endpoint {
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
              }
            }
          }
        }
      }`
    );

    return NextResponse.json({
      registered: results,
      existing: (listResult as any).data?.webhookSubscriptions?.edges?.map((e: any) => e.node) || [],
    });
  } catch (error: any) {
    console.error("Webhook registration error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to register webhooks" },
      { status: 500 }
    );
  }
}
