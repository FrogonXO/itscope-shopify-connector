import { Session } from "@shopify/shopify-api";
import { prisma } from "./db";

export const sessionStorage = {
  async storeSession(session: Session): Promise<boolean> {
    await prisma.session.upsert({
      where: { id: session.id },
      update: {
        shop: session.shop,
        state: session.state,
        isOnline: session.isOnline,
        scope: session.scope,
        expires: session.expires,
        accessToken: session.accessToken || "",
        userId: session.onlineAccessInfo?.associated_user?.id
          ? BigInt(session.onlineAccessInfo.associated_user.id)
          : null,
      },
      create: {
        id: session.id,
        shop: session.shop,
        state: session.state,
        isOnline: session.isOnline,
        scope: session.scope,
        expires: session.expires,
        accessToken: session.accessToken || "",
        userId: session.onlineAccessInfo?.associated_user?.id
          ? BigInt(session.onlineAccessInfo.associated_user.id)
          : null,
      },
    });
    return true;
  },

  async loadSession(id: string): Promise<Session | undefined> {
    const data = await prisma.session.findUnique({ where: { id } });
    if (!data) return undefined;

    const session = new Session({
      id: data.id,
      shop: data.shop,
      state: data.state,
      isOnline: data.isOnline,
    });
    session.scope = data.scope || undefined;
    session.expires = data.expires || undefined;
    session.accessToken = data.accessToken;
    return session;
  },

  async deleteSession(id: string): Promise<boolean> {
    await prisma.session.deleteMany({ where: { id } });
    return true;
  },

  async deleteSessions(ids: string[]): Promise<boolean> {
    await prisma.session.deleteMany({ where: { id: { in: ids } } });
    return true;
  },

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const rows = await prisma.session.findMany({ where: { shop } });
    return rows.map((data) => {
      const session = new Session({
        id: data.id,
        shop: data.shop,
        state: data.state,
        isOnline: data.isOnline,
      });
      session.scope = data.scope || undefined;
      session.expires = data.expires || undefined;
      session.accessToken = data.accessToken;
      return session;
    });
  },
};

// Helper to get a valid offline session for a shop
export async function getOfflineSession(shop: string): Promise<Session | null> {
  const offlineId = `offline_${shop}`;
  const session = await sessionStorage.loadSession(offlineId);
  if (session?.accessToken) return session;

  // Fallback: find any session for this shop with a token
  const sessions = await sessionStorage.findSessionsByShop(shop);
  return sessions.find((s) => s.accessToken) || null;
}
