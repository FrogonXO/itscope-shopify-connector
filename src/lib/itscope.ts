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
  features: Record<string, string>; // All product attributes (e.g. hauptspeicher, festplatte, cpu, etc.)
}

export interface ItScopeProject {
  manufacturerProjectId: string;
  supplierProjectId: string;
  projectName: string;
  price: number;
  remainingQuantity: number;
  validTo?: string;
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
  projects: ItScopeProject[];
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

      // Parse project pricing data
      const projects: ItScopeProject[] = [];
      const rawProjects = item.projects?.project || item.project;
      if (rawProjects) {
        const projectList = Array.isArray(rawProjects) ? rawProjects : [rawProjects];
        for (const proj of projectList) {
          projects.push({
            manufacturerProjectId: String(proj.manufacturerProjectId || ""),
            supplierProjectId: String(proj.supplierProjectId || ""),
            projectName: proj.projectName || "",
            price: parseFloat(proj.price || "0"),
            remainingQuantity: parseInt(proj.remainingQuantity || "0", 10),
            validTo: proj.validTo || undefined,
          });
        }
      }

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
        projects,
      });
    }
  }

  // Sort offers: available first, then by price ascending
  offers.sort((a, b) => {
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;
    return a.price - b.price;
  });

  // Extract all simple string/number properties as features for auto-fill
  const features: Record<string, string> = {};
  for (const [key, val] of Object.entries(product)) {
    if (typeof val === "string" || typeof val === "number") {
      features[key.toLowerCase()] = String(val);
    }
  }
  console.log("ItScope product features:", JSON.stringify(features));

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
    features,
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
  return items.map((item: any) => {
    const projects: ItScopeProject[] = [];
    const rawProjects = item.projects?.project || item.project;
    if (rawProjects) {
      const projectList = Array.isArray(rawProjects) ? rawProjects : [rawProjects];
      for (const proj of projectList) {
        projects.push({
          manufacturerProjectId: String(proj.manufacturerProjectId || ""),
          supplierProjectId: String(proj.supplierProjectId || ""),
          projectName: proj.projectName || "",
          price: parseFloat(proj.price || "0"),
          remainingQuantity: parseInt(proj.remainingQuantity || "0", 10),
          validTo: proj.validTo || undefined,
        });
      }
    }
    return {
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
      projects,
    };
  });
}

// ─── Order Sending ───────────────────────────────────────────────

interface OrderLineItem {
  supplierPid: string;
  itscopeProductId: string;
  quantity: number;
  description: string;
  projectId?: string;
  unitPrice?: number;
  productType?: "service" | "license" | "esd"; // For warranties/licenses/ESD — triggers CUSTOMER_ORDER_REFERENCE
}

interface CustomerParty {
  company: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  zip: string;
  city: string;
  country: string; // ISO country code e.g. "DE"
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
  buyerPhone?: string;
  buyerFax?: string;
  buyerUrl?: string;
  buyerContactName?: string;
  buyerContactEmail?: string;
  deliveryCompany?: string;
  deliveryName?: string;
  deliveryStreet?: string;
  deliveryZip?: string;
  deliveryCity?: string;
  deliveryCountry?: string;
  deliveryContactName?: string;
  deliveryContactEmail?: string;
  deliveryPhone?: string;
  customerParty?: CustomerParty; // End customer (licensee) — required for warranty/license/ESD items
  lineItems: OrderLineItem[];
  remarks?: string;
}

export function buildOrderXml(params: OrderParams): string {
  // Strip country prefix from ZIP for delivery (e.g. "A-1090" → "1090")
  const stripZipPrefix = (zip: string) => zip.replace(/^[A-Z]+-/, "");

  // Build delivery CONTACT_DETAILS if we have contact info
  const deliveryContactName = params.dropship
    ? params.deliveryContactName
    : params.buyerContactName;
  const deliveryContactEmail = params.dropship
    ? params.deliveryContactEmail
    : params.buyerContactEmail;
  const deliveryContactPhone = params.dropship
    ? params.deliveryPhone
    : params.buyerPhone;

  const deliveryContactDetails = deliveryContactName || deliveryContactEmail ? `
            <CONTACT_DETAILS>
              <ns2:CONTACT_NAME>${escapeXml(deliveryContactName || "")}</ns2:CONTACT_NAME>${deliveryContactEmail ? `
              <ns2:EMAILS>
                <ns2:EMAIL>${escapeXml(deliveryContactEmail)}</ns2:EMAIL>
              </ns2:EMAILS>` : ""}
            </CONTACT_DETAILS>` : "";

  const deliveryParty = params.dropship
    ? `<PARTY>
        <ns2:PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}</ns2:PARTY_ID>
        <PARTY_ROLE>delivery</PARTY_ROLE>
        <ADDRESS>
          <ns2:NAME>${escapeXml(params.deliveryCompany || params.buyerCompany)}</ns2:NAME>
          <ns2:NAME2>${escapeXml(params.deliveryName || "")}</ns2:NAME2>${deliveryContactDetails}
          <ns2:STREET>${escapeXml(params.deliveryStreet || params.buyerStreet)}</ns2:STREET>
          <ns2:ZIP>${escapeXml(stripZipPrefix(params.deliveryZip || params.buyerZip))}</ns2:ZIP>
          <ns2:CITY>${escapeXml(params.deliveryCity || params.buyerCity)}</ns2:CITY>
          <ns2:COUNTRY>${escapeXml(params.deliveryCountry || params.buyerCountry)}</ns2:COUNTRY>
          <ns2:COUNTRY_CODED>${escapeXml(params.deliveryCountry || params.buyerCountry)}</ns2:COUNTRY_CODED>${deliveryContactPhone ? `
          <ns2:PHONE type="office">${escapeXml(deliveryContactPhone)}</ns2:PHONE>` : ""}
        </ADDRESS>
      </PARTY>`
    : `<PARTY>
        <ns2:PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}</ns2:PARTY_ID>
        <PARTY_ROLE>delivery</PARTY_ROLE>
        <ADDRESS>
          <ns2:NAME>${escapeXml(params.buyerCompany)}</ns2:NAME>${deliveryContactDetails}
          <ns2:STREET>${escapeXml(params.buyerStreet)}</ns2:STREET>
          <ns2:ZIP>${escapeXml(stripZipPrefix(params.buyerZip))}</ns2:ZIP>
          <ns2:CITY>${escapeXml(params.buyerCity)}</ns2:CITY>
          <ns2:COUNTRY>${escapeXml(params.buyerCountry)}</ns2:COUNTRY>
          <ns2:COUNTRY_CODED>${escapeXml(params.buyerCountry)}</ns2:COUNTRY_CODED>${deliveryContactPhone ? `
          <ns2:PHONE type="office">${escapeXml(deliveryContactPhone)}</ns2:PHONE>` : ""}
        </ADDRESS>
      </PARTY>`;

  // Customer (licensee) party — required for warranty/license/ESD line items
  const hasLicenseeItems = params.lineItems.some((item) => item.productType);
  const customerPartyId = `${params.buyerPartyId}_CUSTOMER`;
  const customerPartyXml = hasLicenseeItems && params.customerParty
    ? `<PARTY>
        <ns2:PARTY_ID type="buyer_specific">${escapeXml(customerPartyId)}</ns2:PARTY_ID>
        <PARTY_ROLE>customer</PARTY_ROLE>
        <ADDRESS>
          <ns2:NAME>${escapeXml(params.customerParty.company || `${params.customerParty.firstName} ${params.customerParty.lastName}`)}</ns2:NAME>
          <CONTACT_DETAILS>
            <ns2:CONTACT_NAME>${escapeXml(params.customerParty.lastName)}</ns2:CONTACT_NAME>
            <ns2:FIRST_NAME>${escapeXml(params.customerParty.firstName)}</ns2:FIRST_NAME>
            <ns2:PHONE>${escapeXml(params.customerParty.phone)}</ns2:PHONE>
            <ns2:EMAILS>
              <ns2:EMAIL>${escapeXml(params.customerParty.email)}</ns2:EMAIL>
            </ns2:EMAILS>
          </CONTACT_DETAILS>
          <ns2:STREET>${escapeXml(params.customerParty.street)}</ns2:STREET>
          <ns2:ZIP>${escapeXml(params.customerParty.zip)}</ns2:ZIP>
          <ns2:CITY>${escapeXml(params.customerParty.city)}</ns2:CITY>
          <ns2:COUNTRY>${escapeXml(params.customerParty.country)}</ns2:COUNTRY>
          <ns2:COUNTRY_CODED>${escapeXml(params.customerParty.country)}</ns2:COUNTRY_CODED>
        </ADDRESS>
      </PARTY>`
    : "";

  const orderItems = params.lineItems
    .map(
      (item, idx) => `
    <ORDER_ITEM>
      <LINE_ITEM_ID>${idx + 1}</LINE_ITEM_ID>
      <PRODUCT_ID>
        <ns2:SUPPLIER_PID type="supplier_specific">${escapeXml(item.supplierPid)}</ns2:SUPPLIER_PID>
        <ns2:INTERNATIONAL_PID type="itscope">${escapeXml(item.itscopeProductId)}</ns2:INTERNATIONAL_PID>
        <ns2:DESCRIPTION_SHORT>${escapeXml(item.description)}</ns2:DESCRIPTION_SHORT>${item.productType ? `
        <ns2:PRODUCT_TYPE>${escapeXml(item.productType)}</ns2:PRODUCT_TYPE>` : ""}
      </PRODUCT_ID>
      <QUANTITY>${item.quantity}</QUANTITY>
      <ns2:ORDER_UNIT>C62</ns2:ORDER_UNIT>${item.unitPrice !== undefined ? `
      <PRODUCT_PRICE_FIX>
        <ns2:PRICE_AMOUNT>${item.unitPrice.toFixed(2)}</ns2:PRICE_AMOUNT>
      </PRODUCT_PRICE_FIX>
      <PRICE_LINE_AMOUNT>${(item.unitPrice * item.quantity).toFixed(2)}</PRICE_LINE_AMOUNT>` : ""}${item.projectId ? `
      <SOURCING_INFO>
        <AGREEMENT>
          <ns2:AGREEMENT_ID>${escapeXml(item.projectId)}</ns2:AGREEMENT_ID>
        </AGREEMENT>
      </SOURCING_INFO>` : ""}${item.productType && params.customerParty ? `
      <CUSTOMER_ORDER_REFERENCE>
        <CUSTOMER_IDREF type="buyer_specific">${escapeXml(customerPartyId)}</CUSTOMER_IDREF>
      </CUSTOMER_ORDER_REFERENCE>` : ""}
    </ORDER_ITEM>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ORDER xmlns="http://www.opentrans.org/XMLSchema/2.1" xmlns:ns2="http://www.bmecat.org/bmecat/2005" version="2.1" type="standard">
  <ORDER_HEADER>
    <CONTROL_INFO>
      <GENERATOR_INFO>ItScope-Shopify-Connector</GENERATOR_INFO>
    </CONTROL_INFO>
    <ORDER_INFO>
      <ORDER_ID>${escapeXml(params.orderId)}</ORDER_ID>
      <ORDER_DATE>${new Date().toISOString()}</ORDER_DATE>
      <PARTIES>
        <PARTY>
          <ns2:PARTY_ID type="supplier_specific">${escapeXml(params.supplierId)}</ns2:PARTY_ID>
          <PARTY_ROLE>supplier</PARTY_ROLE>
        </PARTY>
        <PARTY>
          <ns2:PARTY_ID type="buyer_specific">${escapeXml(params.buyerPartyId)}</ns2:PARTY_ID>
          <PARTY_ROLE>buyer</PARTY_ROLE>
          <ADDRESS>
            <ns2:NAME>${escapeXml(params.buyerCompany)}</ns2:NAME>${params.buyerContactName || params.buyerContactEmail ? `
            <CONTACT_DETAILS>
              <ns2:CONTACT_NAME>${escapeXml(params.buyerContactName || params.buyerCompany)}</ns2:CONTACT_NAME>${params.buyerContactEmail ? `
              <ns2:EMAILS>
                <ns2:EMAIL>${escapeXml(params.buyerContactEmail)}</ns2:EMAIL>
              </ns2:EMAILS>` : ""}
            </CONTACT_DETAILS>` : ""}
            <ns2:STREET>${escapeXml(params.buyerStreet)}</ns2:STREET>
            <ns2:ZIP>${escapeXml(params.buyerZip)}</ns2:ZIP>
            <ns2:CITY>${escapeXml(params.buyerCity)}</ns2:CITY>
            <ns2:COUNTRY>${escapeXml(params.buyerCountry)}</ns2:COUNTRY>
            <ns2:COUNTRY_CODED>${escapeXml(params.buyerCountry)}</ns2:COUNTRY_CODED>${params.buyerPhone ? `
            <ns2:PHONE type="office">${escapeXml(params.buyerPhone)}</ns2:PHONE>` : ""}${params.buyerFax ? `
            <ns2:FAX type="office">${escapeXml(params.buyerFax)}</ns2:FAX>` : ""}${params.buyerUrl ? `
            <ns2:URL>${escapeXml(params.buyerUrl)}</ns2:URL>` : ""}
          </ADDRESS>
        </PARTY>
        ${deliveryParty}
        ${customerPartyXml}
      </PARTIES>
      <CUSTOMER_ORDER_REFERENCE>
        <ORDER_ID>${escapeXml(params.orderId)}</ORDER_ID>
      </CUSTOMER_ORDER_REFERENCE>
      <ORDER_PARTIES_REFERENCE>
        <ns2:BUYER_IDREF type="buyer_specific">${escapeXml(params.buyerPartyId)}</ns2:BUYER_IDREF>
        <ns2:SUPPLIER_IDREF type="supplier_specific">${escapeXml(params.supplierId)}</ns2:SUPPLIER_IDREF>
      </ORDER_PARTIES_REFERENCE>
      <PARTIAL_SHIPMENT_ALLOWED>true</PARTIAL_SHIPMENT_ALLOWED>
      ${params.remarks ? `<REMARKS type="general">${escapeXml(params.remarks)}</REMARKS>` : ""}
      ${params.dropship ? "<HEADER_UDX><UDX.DROPSHIPMENT>true</UDX.DROPSHIPMENT></HEADER_UDX>" : ""}
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
  console.log(`ItScope sendOrder response (${response.status}):`, responseText);

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${responseText}` };
  }

  const parsed = parser.parse(responseText);
  console.log("ItScope sendOrder parsed response:", JSON.stringify(parsed));
  const dealId = parsed?.DEAL?.ID || parsed?.DEAL?.ORDERID || parsed?.orderId
    || parsed?.deal?.id || parsed?.deal?.orderId;

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
