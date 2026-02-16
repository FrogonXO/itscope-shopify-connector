import { XMLParser } from "fast-xml-parser";

const ITSCOPE_BASE_URL = "https://api.itscope.com/2.1";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function getAuthHeader(): string {
  const accountId = process.env.ITSCOPE_ACCOUNT_ID!;
  const apiKey = process.env.ITSCOPE_API_KEY!;
  const credentials = Buffer.from(`${accountId}:${apiKey}`).toString("base64");
  return `Basic ${credentials}`;
}

function getHeaders(): Record<string, string> {
  return {
    Authorization: getAuthHeader(),
    "User-Agent": "ItScopeShopifyConnector-App-1.0",
    Accept: "application/xml",
  };
}

// ─── Product Search ──────────────────────────────────────────────

export interface ItScopeProduct {
  productId: string;
  name: string;
  manufacturer: string;
  manufacturerSku: string;
  ean: string;
  shortDescription: string;
  longDescription: string;
  imageUrl: string;
  imageThumb: string;
  bestPrice: number;
  bestStock: number;
  aggregatedStock: number;
  offers: ItScopeOffer[];
}

export interface ItScopeOffer {
  supplierItemId: string;
  distributorId: string;
  distributorName: string;
  supplierSKU: string;
  price: number;
  priceCalc: number;
  stock: number;
  stockStatusText: string;
  condition: string;
  available: boolean;
}

export async function searchProductBySku(
  sku: string
): Promise<ItScopeProduct | null> {
  // ItScope requires special encoding for / and # in SKUs
  // Try standard encoding first, then double-encoding
  const encodingStrategies = [
    encodeURIComponent(sku),
    sku.replace(/\//g, "%252F").replace(/#/g, "%2523").replace(/ /g, "%20"),
  ];

  for (const encoded of encodingStrategies) {
    const url = `${ITSCOPE_BASE_URL}/products/search/hstpid=${encoded}/standard.xml?plzproducts=true`;
    console.log(`ItScope search: ${url}`);

    const response = await fetch(url, { headers: getHeaders() });
    if (!response.ok) {
      console.error(`ItScope search failed: ${response.status}`);
      continue;
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);

    // ItScope returns: <products><product>...</product></products>
    const products = parsed?.products?.product;
    if (!products) continue;

    const product = Array.isArray(products) ? products[0] : products;
    return parseProduct(product, sku);
  }

  return null;
}

function parseProduct(product: any, sku: string): ItScopeProduct {
  // Extract supplier offers from supplierItems.supplierItem[]
  const offers: ItScopeOffer[] = [];
  const supplierItems = product?.supplierItems?.supplierItem;

  if (supplierItems) {
    const items = Array.isArray(supplierItems) ? supplierItems : [supplierItems];
    for (const item of items) {
      // Skip refurbished/bulk items and items with zero price
      const condition = item.conditionName || "";
      const price = parseFloat(item.price || "0");

      offers.push({
        supplierItemId: String(item.id || ""),
        distributorId: String(item.supplierId || ""),
        distributorName: item.supplierName || "",
        supplierSKU: String(item.supplierSKU || ""),
        price,
        priceCalc: parseFloat(item.priceCalc || "0"),
        stock: parseInt(item.stock || "0", 10),
        stockStatusText: item.stockStatusText || "",
        condition,
        available: (item.stockStatus === 1 || item.stockStatus === 3) && price > 0,
      });
    }
  }

  // Sort offers: available first, then by price ascending
  offers.sort((a, b) => {
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;
    return a.price - b.price;
  });

  return {
    productId: String(product.puid || ""),
    name: product.productName || "",
    manufacturer: product.manufacturerName || "",
    manufacturerSku: product.manufacturerSKU || sku,
    ean: String(product.ean || ""),
    shortDescription: product.shortDescription || "",
    longDescription: product.longDescription || "",
    imageUrl: product.imageHighRes1 || product.imageThumb || "",
    imageThumb: product.imageThumb || "",
    bestPrice: parseFloat(product.price || "0"),
    bestStock: parseInt(product.stock || "0", 10),
    aggregatedStock: parseInt(product.aggregatedStock || "0", 10),
    offers,
  };
}

// ─── Stock / Availability ────────────────────────────────────────

export async function getProductStock(
  productId: string
): Promise<ItScopeOffer[]> {
  const url = `${ITSCOPE_BASE_URL}/products/id/${productId}/standard.xml?plzproducts=true`;

  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    console.error(`ItScope stock fetch failed: ${response.status}`);
    return [];
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  // products/id returns same structure as search
  const product = parsed?.products?.product;
  if (!product) return [];

  const supplierItems = product?.supplierItems?.supplierItem;
  if (!supplierItems) return [];

  const items = Array.isArray(supplierItems) ? supplierItems : [supplierItems];
  return items.map((item: any) => ({
    supplierItemId: String(item.id || ""),
    distributorId: String(item.supplierId || ""),
    distributorName: item.supplierName || "",
    supplierSKU: String(item.supplierSKU || ""),
    price: parseFloat(item.price || "0"),
    priceCalc: parseFloat(item.priceCalc || "0"),
    stock: parseInt(item.stock || "0", 10),
    stockStatusText: item.stockStatusText || "",
    condition: item.conditionName || "",
    available: (item.stockStatus === 1 || item.stockStatus === 3) && parseFloat(item.price || "0") > 0,
  }));
}

// ─── Order Sending ───────────────────────────────────────────────

interface OrderLineItem {
  supplierPid: string;
  itscopeProductId: string;
  quantity: number;
  description: string;
}

interface OrderParams {
  orderId: string; // max 18 chars
  supplierId: string;
  dropship: boolean;
  buyerPartyId: string;
  buyerCompany: string;
  buyerStreet: string;
  buyerZip: string;
  buyerCity: string;
  buyerCountry: string;
  deliveryCompany?: string;
  deliveryName?: string;
  deliveryStreet?: string;
  deliveryZip?: string;
  deliveryCity?: string;
  deliveryCountry?: string;
  lineItems: OrderLineItem[];
  remarks?: string;
}

export function buildOrderXml(params: OrderParams): string {
  const deliveryParty = params.dropship
    ? `<PARTY>
        <PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}_DELIVERY</PARTY_ID>
        <PARTY_ROLE>delivery</PARTY_ROLE>
        <ADDRESS>
          <NAME>${escapeXml(params.deliveryCompany || params.buyerCompany)}</NAME>
          <NAME2>${escapeXml(params.deliveryName || "")}</NAME2>
          <STREET>${escapeXml(params.deliveryStreet || params.buyerStreet)}</STREET>
          <ZIP>${escapeXml(params.deliveryZip || params.buyerZip)}</ZIP>
          <CITY>${escapeXml(params.deliveryCity || params.buyerCity)}</CITY>
          <COUNTRY>${escapeXml(params.deliveryCountry || params.buyerCountry)}</COUNTRY>
        </ADDRESS>
      </PARTY>`
    : `<PARTY>
        <PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}_DELIVERY</PARTY_ID>
        <PARTY_ROLE>delivery</PARTY_ROLE>
        <ADDRESS>
          <NAME>${escapeXml(params.buyerCompany)}</NAME>
          <STREET>${escapeXml(params.buyerStreet)}</STREET>
          <ZIP>${escapeXml(params.buyerZip)}</ZIP>
          <CITY>${escapeXml(params.buyerCity)}</CITY>
          <COUNTRY>${escapeXml(params.buyerCountry)}</COUNTRY>
        </ADDRESS>
      </PARTY>`;

  const orderItems = params.lineItems
    .map(
      (item, idx) => `
    <ORDER_ITEM>
      <LINE_ITEM_ID>${idx + 1}</LINE_ITEM_ID>
      <PRODUCT_ID>
        <SUPPLIER_PID type="supplier_specific">${escapeXml(item.supplierPid)}</SUPPLIER_PID>
        <INTERNATIONAL_PID type="itscope">${escapeXml(item.itscopeProductId)}</INTERNATIONAL_PID>
        <DESCRIPTION_SHORT>${escapeXml(item.description)}</DESCRIPTION_SHORT>
      </PRODUCT_ID>
      <QUANTITY>${item.quantity}</QUANTITY>
      <ORDER_UNIT>C62</ORDER_UNIT>
    </ORDER_ITEM>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ORDER xmlns="http://www.opentrans.org/XMLSchema/2.1" version="2.1" type="standard">
  <ORDER_HEADER>
    <CONTROL_INFO>
      <GENERATOR_INFO>ItScope-Shopify-Connector</GENERATOR_INFO>
    </CONTROL_INFO>
    <ORDER_INFO>
      <ORDER_ID>${escapeXml(params.orderId)}</ORDER_ID>
      <ORDER_DATE>${new Date().toISOString()}</ORDER_DATE>
      <PARTIES>
        <PARTY>
          <PARTY_ID type="supplier_specific">${escapeXml(params.supplierId)}</PARTY_ID>
          <PARTY_ROLE>supplier</PARTY_ROLE>
        </PARTY>
        <PARTY>
          <PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}</PARTY_ID>
          <PARTY_ROLE>buyer</PARTY_ROLE>
          <ADDRESS>
            <NAME>${escapeXml(params.buyerCompany)}</NAME>
            <STREET>${escapeXml(params.buyerStreet)}</STREET>
            <ZIP>${escapeXml(params.buyerZip)}</ZIP>
            <CITY>${escapeXml(params.buyerCity)}</CITY>
            <COUNTRY>${escapeXml(params.buyerCountry)}</COUNTRY>
          </ADDRESS>
        </PARTY>
        ${deliveryParty}
      </PARTIES>
      ${params.dropship ? "<HEADER_UDX><UDX.DROPSHIPMENT>true</UDX.DROPSHIPMENT></HEADER_UDX>" : ""}
      <PARTIAL_SHIPMENT_ALLOWED>true</PARTIAL_SHIPMENT_ALLOWED>
      ${params.remarks ? `<REMARKS type="general">${escapeXml(params.remarks)}</REMARKS>` : ""}
    </ORDER_INFO>
  </ORDER_HEADER>
  <ORDER_ITEM_LIST>
    ${orderItems}
  </ORDER_ITEM_LIST>
  <ORDER_SUMMARY>
    <TOTAL_ITEM_NUM>${params.lineItems.length}</TOTAL_ITEM_NUM>
  </ORDER_SUMMARY>
</ORDER>`;
}

export async function sendOrder(
  supplierId: string,
  orderXml: string
): Promise<{ success: boolean; dealId?: string; error?: string }> {
  const url = `https://api.itscope.com/2.0/business/deals/send/${supplierId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getHeaders(),
      "Content-Type": "application/xml;charset=UTF-8",
    },
    body: orderXml,
  });

  const responseText = await response.text();

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${responseText}` };
  }

  const parsed = parser.parse(responseText);
  const dealId = parsed?.DEAL?.ID || parsed?.DEAL?.ORDERID || parsed?.orderId;

  return { success: true, dealId: String(dealId || "") };
}

// ─── Deal / Order Status ─────────────────────────────────────────

export interface DealStatus {
  dealId: string;
  status: string;
  statusMessage: string;
  statusDate: string;
  trackingNumber?: string;
  serialNumbers?: string[];
  dispatchDocumentUrl?: string;
  invoiceDocumentUrl?: string;
}

export async function getDealStatus(dealId: string): Promise<DealStatus | null> {
  const url = `${ITSCOPE_BASE_URL}/business/deals/sales/search/orderId=${dealId}/deal.xml`;

  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    console.error(`ItScope deal status fetch failed: ${response.status}`);
    return null;
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  // Try both uppercase and lowercase field names
  const deal = parsed?.dealList?.deal || parsed?.DEALLIST?.DEAL || parsed?.deal || parsed?.DEAL;
  if (!deal) return null;

  const actualDeal = Array.isArray(deal) ? deal[0] : deal;

  const dispatchDocs = actualDeal?.dispatchnotifications?.document ||
    actualDeal?.DISPATCHNOTIFICATIONS?.DOCUMENT;
  const invoiceDocs = actualDeal?.invoices?.document ||
    actualDeal?.INVOICES?.DOCUMENT;

  return {
    dealId: actualDeal?.orderId || actualDeal?.ORDERID || actualDeal?.id || dealId,
    status: actualDeal?.status || actualDeal?.STATUS || "",
    statusMessage: actualDeal?.statusMessage || actualDeal?.STATUSMESSAGE || "",
    statusDate: actualDeal?.statusDate || actualDeal?.STATUSDATE || "",
    dispatchDocumentUrl: dispatchDocs
      ? Array.isArray(dispatchDocs)
        ? dispatchDocs[0]?.documentUrl || dispatchDocs[0]?.DOCUMENTURL
        : dispatchDocs?.documentUrl || dispatchDocs?.DOCUMENTURL
      : undefined,
    invoiceDocumentUrl: invoiceDocs
      ? Array.isArray(invoiceDocs)
        ? invoiceDocs[0]?.documentUrl || invoiceDocs[0]?.DOCUMENTURL
        : invoiceDocs?.documentUrl || invoiceDocs?.DOCUMENTURL
      : undefined,
  };
}

export async function fetchDispatchDocument(
  documentUrl: string
): Promise<{ trackingNumbers: string[]; serialNumbers: string[] }> {
  const response = await fetch(documentUrl, { headers: getHeaders() });
  if (!response.ok) {
    return { trackingNumbers: [], serialNumbers: [] };
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  const trackingNumbers: string[] = [];
  const serialNumbers: string[] = [];

  // Navigate OpenTrans 2.1 DISPATCHNOTIFICATION structure
  const dispatch = parsed?.DISPATCHNOTIFICATION;
  if (!dispatch) return { trackingNumbers, serialNumbers };

  const shipmentId =
    dispatch?.DISPATCHNOTIFICATION_HEADER?.DISPATCHNOTIFICATION_INFO?.SHIPMENT_ID;
  if (shipmentId) {
    trackingNumbers.push(String(shipmentId));
  }

  const items =
    dispatch?.DISPATCHNOTIFICATION_ITEM_LIST?.DISPATCHNOTIFICATION_ITEM;
  if (items) {
    const itemList = Array.isArray(items) ? items : [items];
    for (const item of itemList) {
      const serials = item?.SERIAL_NUMBER || item?.UDX?.SERIALNUMBER;
      if (serials) {
        const serialList = Array.isArray(serials) ? serials : [serials];
        serialNumbers.push(...serialList.map(String));
      }
    }
  }

  return { trackingNumbers, serialNumbers };
}

// ─── Helpers ─────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
