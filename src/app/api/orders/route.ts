import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET - List all orders for a shop
export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop) {
    return NextResponse.json({ error: "Missing shop" }, { status: 400 });
  }

  const orders = await prisma.order.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json(orders);
}
