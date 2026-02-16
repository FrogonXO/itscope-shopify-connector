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
  description: string;
  imageUrl: string;
  offers: ItScopeOffer[];
}

export interface ItScopeOffer {
  distributorId: string;
  distributorName: string;
  price: number;
  stock: number;
  availabilityStatus: string;
  deliveryTime: string;
}

export async function searchProductBySku(
  sku: string
): Promise<ItScopeProduct | null> {
  const url = `${ITSCOPE_BASE_URL}/products/search/hstpid=${encodeURIComponent(sku)}/standard.xml`;

  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    console.error(`ItScope product search failed: ${response.status}`);
    return null;
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  // Navigate the ItScope XML structure
  const products = parsed?.PRODUCTLIST?.PRODUCT;
  if (!products) return null;

  const product = Array.isArray(products) ? products[0] : products;

  // Extract offers/price lines
  const priceLines = product?.PRICELINES?.PRICELINE;
  const offers: ItScopeOffer[] = [];

  if (priceLines) {
    const lines = Array.isArray(priceLines) ? priceLines : [priceLines];
    for (const line of lines) {
      offers.push({
        distributorId: line?.SUPPLIER?.["@_id"] || line?.SUPPLIER?.ID || "",
        distributorName: line?.SUPPLIER?.NAME || line?.SUPPLIER?.["#text"] || "",
        price: parseFloat(line?.PRICE?.AMOUNT || line?.PRICE || "0"),
        stock: parseInt(line?.STOCK?.QUANTITY || line?.STOCK || "0", 10),
        availabilityStatus: line?.STOCK?.STATUS || line?.AVAILABILITY || "",
        deliveryTime: line?.DELIVERYTIME || "",
      });
    }
  }

  return {
    productId: product?.["@_id"] || product?.ID || "",
    name: product?.NAME || product?.TITLE || "",
    manufacturer: product?.MANUFACTURER?.NAME || product?.MANUFACTURER || "",
    manufacturerSku: product?.MANUFACTURERSKU || product?.HSTPID || sku,
    ean: product?.EAN || "",
    description: product?.DESCRIPTION || product?.LONGDESCRIPTION || "",
    imageUrl: product?.IMAGE?.URL || product?.IMAGEURL || "",
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

  const product = parsed?.PRODUCTLIST?.PRODUCT || parsed?.PRODUCT;
  if (!product) return [];

  const priceLines = product?.PRICELINES?.PRICELINE;
  if (!priceLines) return [];

  const lines = Array.isArray(priceLines) ? priceLines : [priceLines];
  return lines.map((line: any) => ({
    distributorId: line?.SUPPLIER?.["@_id"] || line?.SUPPLIER?.ID || "",
    distributorName: line?.SUPPLIER?.NAME || line?.SUPPLIER?.["#text"] || "",
    price: parseFloat(line?.PRICE?.AMOUNT || line?.PRICE || "0"),
    stock: parseInt(line?.STOCK?.QUANTITY || line?.STOCK || "0", 10),
    availabilityStatus: line?.STOCK?.STATUS || line?.AVAILABILITY || "",
    deliveryTime: line?.DELIVERYTIME || "",
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
  buyerPartyId: string; // your customer number at the distributor
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
  // Note: Order sending uses API v2.0 endpoint as per documentation
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

  const deal = parsed?.DEALLIST?.DEAL || parsed?.DEAL;
  if (!deal) return null;

  const dispatchDocs = deal?.DISPATCHNOTIFICATIONS?.DOCUMENT;
  const invoiceDocs = deal?.INVOICES?.DOCUMENT;

  return {
    dealId: deal?.ORDERID || deal?.ID || dealId,
    status: deal?.STATUS || "",
    statusMessage: deal?.STATUSMESSAGE || "",
    statusDate: deal?.STATUSDATE || "",
    dispatchDocumentUrl: dispatchDocs
      ? Array.isArray(dispatchDocs)
        ? dispatchDocs[0]?.DOCUMENTURL
        : dispatchDocs?.DOCUMENTURL
      : undefined,
    invoiceDocumentUrl: invoiceDocs
      ? Array.isArray(invoiceDocs)
        ? invoiceDocs[0]?.DOCUMENTURL
        : invoiceDocs?.DOCUMENTURL
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

  // Extract tracking from shipment parties / logistics info
  const shipmentId =
    dispatch?.DISPATCHNOTIFICATION_HEADER?.DISPATCHNOTIFICATION_INFO?.SHIPMENT_ID;
  if (shipmentId) {
    trackingNumbers.push(String(shipmentId));
  }

  // Extract from dispatch items for serial numbers
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
