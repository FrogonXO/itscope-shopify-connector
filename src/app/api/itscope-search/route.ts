import { NextRequest, NextResponse } from "next/server";
import { searchProductBySku } from "@/lib/itscope";

export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get("sku");
  const shop = request.nextUrl.searchParams.get("shop");

  if (!sku || !shop) {
    return NextResponse.json(
      { error: "Missing sku or shop parameter" },
      { status: 400 }
    );
  }

  if (process.env.DISABLE_ITSCOPE_CONNECTION === "true") {
    return NextResponse.json({ error: "ItScope connection is currently disabled" }, { status: 503 });
  }

  try {
    const product = await searchProductBySku(sku);

    if (!product) {
      return NextResponse.json(
        { error: "Product not found in ItScope" },
        { status: 404 }
      );
    }

    return NextResponse.json(product);
  } catch (error: any) {
    console.error("ItScope search error:", error);
    return NextResponse.json(
      { error: error.message || "Search failed" },
      { status: 500 }
    );
  }
}
