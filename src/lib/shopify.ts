import "@shopify/shopify-api/adapters/node";
import {
  shopifyApi,
  ApiVersion,
  Session,
  DeliveryMethod,
} from "@shopify/shopify-api";

// Lazy initialization to avoid build-time errors when env vars aren't set yet
let _shopify: ReturnType<typeof shopifyApi> | null = null;

function getShopifyInstance() {
  if (!_shopify) {
    const hostName = (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, "");

    if (!hostName) {
      throw new Error(
        "SHOPIFY_APP_URL environment variable is not set. Please set it to your Vercel deployment URL."
      );
    }

    _shopify = shopifyApi({
      apiKey: process.env.SHOPIFY_API_KEY || "",
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      scopes: (process.env.SHOPIFY_SCOPES || "").split(","),
      hostName,
      apiVersion: ApiVersion.January25,
      isEmbeddedApp: true,
    });

    // Register webhook handlers
    _shopify.webhooks.addHandlers({
      ORDERS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/api/webhooks",
      },
      APP_UNINSTALLED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/api/webhooks",
      },
    });
  }
  return _shopify;
}

// Export as a getter so it's only initialized when actually used at runtime
const shopify = new Proxy({} as ReturnType<typeof shopifyApi>, {
  get(_target, prop) {
    return (getShopifyInstance() as any)[prop];
  },
});

export default shopify;
export { Session };

// Helper to create a GraphQL client for a shop
export async function getShopifyClient(shop: string, accessToken: string) {
  const instance = getShopifyInstance();

  const session = new Session({
    id: `${shop}_offline`,
    shop,
    state: "",
    isOnline: false,
    accessToken,
  });

  return new instance.clients.Graphql({ session });
}
