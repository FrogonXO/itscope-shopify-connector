import "@shopify/shopify-api/adapters/node";
import {
  shopifyApi,
  ApiVersion,
  Session,
} from "@shopify/shopify-api";

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: (process.env.SHOPIFY_SCOPES || "").split(","),
  hostName: (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, ""),
  apiVersion: ApiVersion.January26,
  isEmbeddedApp: true,
});

export default shopify;
export { Session };

// Helper to create a GraphQL client for a shop
export async function getShopifyClient(shop: string, accessToken: string) {
  const session = new Session({
    id: `${shop}_offline`,
    shop,
    state: "",
    isOnline: false,
    accessToken,
  });

  return new shopify.clients.Graphql({ session });
}
