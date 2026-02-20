"use client";

import { useCallback, useEffect, useState } from "react";
import { isAllowedDistributor } from "@/lib/distributors";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  DataTable,
  Badge,
  Select,
  RadioButton,
  Spinner,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Modal,
} from "@shopify/polaris";

type ProductType = "Laptop" | "Warranty" | "Accessory";

interface MetafieldConfig {
  key: string;
  label: string;
  placeholder: string;
  autoFill?: "manufacturer";
}

const PRODUCT_TYPE_METAFIELDS: Record<ProductType, MetafieldConfig[]> = {
  Laptop: [
    { key: "custom.brand", label: "Brand", placeholder: "e.g., Lenovo", autoFill: "manufacturer" },
    { key: "custom.cpu", label: "CPU", placeholder: "e.g., Intel Core i7-1365U" },
    { key: "custom.ram", label: "RAM", placeholder: "e.g., 16 GB" },
    { key: "custom.storage", label: "Storage", placeholder: "e.g., 512 GB" },
    { key: "custom.screensize", label: "Screen Size", placeholder: "e.g., 14\"" },
    { key: "custom.gpu", label: "GPU", placeholder: "e.g., Intel Iris Xe" },
    { key: "custom.screenresolution", label: "Screen Resolution", placeholder: "e.g., 1920x1200" },
    { key: "custom.feature_1_title", label: "Feature 1 Title", placeholder: "e.g., Fingerprint Reader" },
    { key: "custom.feature_1_subtitle", label: "Feature 1 Subtitle", placeholder: "e.g., Built-in for secure login" },
  ],
  Warranty: [
    { key: "custom.brand", label: "Brand", placeholder: "e.g., Lenovo", autoFill: "manufacturer" },
    { key: "custom.warranty_duration", label: "Warranty Duration", placeholder: "e.g., 3 Years" },
    { key: "custom.warranty_type", label: "Warranty Type", placeholder: "e.g., On-site, Carry-in" },
    { key: "custom.coverage", label: "Coverage", placeholder: "e.g., Accidental Damage, Standard" },
  ],
  Accessory: [
    { key: "custom.brand", label: "Brand", placeholder: "e.g., Logitech", autoFill: "manufacturer" },
    { key: "custom.addon_type", label: "Add-on Type", placeholder: "e.g., Mouse, Backpack, Docking Station" },
    { key: "custom.compatibility", label: "Compatibility", placeholder: "e.g., Universal, USB-C" },
    { key: "custom.color", label: "Color", placeholder: "e.g., Black" },
  ],
};

// Auto-detect metafield values from ItScope product data
function autoFillMetafields(product: ItScopeProduct, type: ProductType): Record<string, string> {
  const text = `${product.name} ${product.shortDescription}`;
  const f = product.features || {};
  const values: Record<string, string> = {};

  // Build named attributes map from ItScope indexed attribute pairs
  // e.g. attributetypename3="Hauptspeicher" + attributevalue3="16GB" → attrs["hauptspeicher"] = "16GB"
  const attrs: Record<string, string> = {};
  for (let i = 1; i <= 20; i++) {
    const name = f[`attributetypename${i}`];
    const value = f[`attributevalue${i}`];
    if (name && value) attrs[name.toLowerCase()] = value;
  }

  if (type === "Laptop") {
    values["custom.brand"] = product.manufacturer || "";

    // CPU: use ItScope attribute, fallback to regex
    if (attrs["cpu"]) {
      values["custom.cpu"] = attrs["cpu"];
    } else {
      const cpuMatch = text.match(/(?:Intel\s+Core\s+(?:Ultra\s+)?\w[\w-]*(?:\s+\w[\w-]*)?|AMD\s+Ryzen\s+\d\s+\w+|Apple\s+M\d\w*(?:\s+(?:Pro|Max|Ultra))?|Intel\s+(?:Celeron|Pentium|Core\s+i\d)[\w\s-]*?\d{4}\w*)/i);
      if (cpuMatch) values["custom.cpu"] = cpuMatch[0].trim();
    }

    // RAM: use ItScope "Hauptspeicher" attribute, fallback to regex
    if (attrs["hauptspeicher"]) {
      const ramNum = attrs["hauptspeicher"].match(/(\d+)/);
      values["custom.ram"] = ramNum ? `${ramNum[1]} GB` : attrs["hauptspeicher"];
    } else {
      const allGB = [...text.matchAll(/(\d+)\s*GB/gi)].map(m => parseInt(m[1]));
      const unique = [...new Set(allGB)].sort((a, b) => a - b);
      if (unique.length >= 2) {
        values["custom.ram"] = `${unique[0]} GB`; // smaller = RAM
      } else if (unique.length === 1) {
        values["custom.ram"] = `${unique[0]} GB`;
      }
    }

    // Storage: use ItScope "Festplatte" attribute, fallback to regex
    if (attrs["festplatte"]) {
      const storNum = attrs["festplatte"].match(/(\d+)/);
      const unit = /TB/i.test(attrs["festplatte"]) ? "TB" : "GB";
      values["custom.storage"] = storNum ? `${storNum[1]} ${unit}` : attrs["festplatte"];
    } else {
      const tbMatch = text.match(/(\d+)\s*TB/i);
      if (tbMatch) {
        values["custom.storage"] = `${tbMatch[1]} TB`;
      } else {
        const allGB = [...text.matchAll(/(\d+)\s*GB/gi)].map(m => parseInt(m[1]));
        const unique = [...new Set(allGB)].sort((a, b) => a - b);
        if (unique.length >= 2) {
          values["custom.storage"] = `${unique[unique.length - 1]} GB`; // larger = storage
        }
      }
    }

    // Screen size: use ItScope "Bilddiagonale (Zoll)" attribute, fallback to regex
    const screenAttr = attrs["bilddiagonale (zoll)"] || attrs["bildschirmdiagonale"] || attrs["bildschirmdiagonale (zoll)"];
    if (screenAttr) {
      const sizeNum = screenAttr.match(/(\d{2}[.,]?\d?)/);
      if (sizeNum) values["custom.screensize"] = `${sizeNum[1].replace(",", ".")}"`;
    } else {
      const screenMatch = text.match(/(\d{2}[.,]\d)\s*["″]|(\d{2}[.,]\d)\s*(?:inch|Zoll|zoll)|(\d{2})\s*["″]|(\d{2})\s*(?:inch|Zoll|zoll)/i);
      if (screenMatch) {
        const size = (screenMatch[1] || screenMatch[2] || screenMatch[3] || screenMatch[4]).replace(",", ".");
        values["custom.screensize"] = `${size}"`;
      }
    }

    // GPU: use ItScope attribute or regex
    const gpuAttr = attrs["grafikkarte"] || attrs["gpu"] || attrs["grafik"];
    if (gpuAttr) {
      values["custom.gpu"] = gpuAttr;
    } else {
      const gpuMatch = text.match(/(?:NVIDIA\s+)?GeForce\s+\w+\s*\w*\s*\w*|Intel\s+(?:Iris\s+Xe|UHD)\s*\w*|AMD\s+Radeon\s+\w+\s*\w*/i);
      if (gpuMatch) values["custom.gpu"] = gpuMatch[0].trim();
    }

    // Resolution: parse from htmlspecs (has detailed specs beyond the 5 indexed attributes)
    const specs = f.htmlspecs || "";
    const specsResMatch = specs.match(/Aufl.sung[^<]*<\/div><div class="ITSv">([^<]+)/i);
    if (specsResMatch) {
      const resNum = specsResMatch[1].match(/(\d{3,4})\s*[*xX×]\s*(\d{3,4})/);
      values["custom.screenresolution"] = resNum ? `${resNum[1]}x${resNum[2]}` : specsResMatch[1].trim();
    } else {
      const resMatch = text.match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/);
      if (resMatch) {
        values["custom.screenresolution"] = `${resMatch[1]}x${resMatch[2]}`;
      } else {
        const resName = text.match(/\b(FHD|Full\s*HD|WUXGA|QHD|WQHD|4K|UHD|OLED|IPS)\b/i);
        if (resName) values["custom.screenresolution"] = resName[0].toUpperCase();
      }
    }
  }

  if (type === "Warranty") {
    values["custom.brand"] = product.manufacturer || "";

    // Duration: 3 Jahre, 5 Years, 36 Monate, 3Y, etc.
    const durationMatch = text.match(/(\d+)\s*(?:Jahre?|Years?|ans?)\b/i) || text.match(/(\d+)\s*(?:Monate?|Months?)\b/i) || text.match(/(\d+)Y\b/);
    if (durationMatch) {
      const num = parseInt(durationMatch[1]);
      const isMonths = /monat|month/i.test(durationMatch[0]);
      values["custom.warranty_duration"] = isMonths ? `${num} Months` : `${num} Years`;
    }

    // Type: On-Site, Vor-Ort, Carry-in, Mail-in, etc.
    const typeMatch = text.match(/\b(On-?Site|Vor-?Ort|Carry-?in|Mail-?in|Bring-?in|Pick-?up|Return|Depot)\b/i);
    if (typeMatch) values["custom.warranty_type"] = typeMatch[0];

    // Coverage: Accidental Damage, Premier Support, etc.
    const coverageMatch = text.match(/\b(Accidental\s*Damage\s*(?:Protection)?|ADP|Premier\s*Support|Keep\s*Your\s*Drive|Battery\s*Replacement|Sealed\s*Battery|International\s*Warranty)\b/i);
    if (coverageMatch) values["custom.coverage"] = coverageMatch[0];
  }

  if (type === "Accessory") {
    values["custom.brand"] = product.manufacturer || "";

    // Addon type
    const typePatterns: [RegExp, string][] = [
      [/\b(?:Mouse|Maus)\b/i, "Mouse"],
      [/\b(?:Keyboard|Tastatur)\b/i, "Keyboard"],
      [/\b(?:Backpack|Rucksack)\b/i, "Backpack"],
      [/\b(?:Laptop\s*(?:Bag|Tasche)|Notebook\s*(?:Bag|Tasche)|Sleeve|Case)\b/i, "Laptop Bag"],
      [/\b(?:Docking\s*Station|Dock|Thunderbolt\s*Dock)\b/i, "Docking Station"],
      [/\b(?:Monitor|Display|Bildschirm)\b/i, "Monitor"],
      [/\b(?:Headset|Kopfhörer)\b/i, "Headset"],
      [/\b(?:Webcam|Kamera)\b/i, "Webcam"],
      [/\b(?:Charger|Netzteil|Power\s*Adapter)\b/i, "Charger"],
      [/\b(?:USB[\s-]*Hub)\b/i, "USB Hub"],
      [/\b(?:Stylus|Pen|Stift)\b/i, "Stylus"],
    ];
    for (const [pattern, label] of typePatterns) {
      if (pattern.test(text)) { values["custom.addon_type"] = label; break; }
    }

    // Compatibility: USB-C, USB-A, Bluetooth, etc.
    const connPatterns: string[] = [];
    if (/\bUSB[\s-]*C\b/i.test(text)) connPatterns.push("USB-C");
    if (/\bUSB[\s-]*A\b/i.test(text)) connPatterns.push("USB-A");
    if (/\bBluetooth\b/i.test(text)) connPatterns.push("Bluetooth");
    if (/\bWireless|Kabellos|2\.4\s*GHz\b/i.test(text)) connPatterns.push("Wireless");
    if (/\bThunderbolt\b/i.test(text)) connPatterns.push("Thunderbolt");
    if (connPatterns.length > 0) values["custom.compatibility"] = connPatterns.join(", ");

    // Color
    const colorPatterns: [RegExp, string][] = [
      [/\b(?:Black|Schwarz)\b/i, "Black"],
      [/\b(?:Silver|Silber)\b/i, "Silver"],
      [/\b(?:White|Weiß|Weiss)\b/i, "White"],
      [/\b(?:Grey|Gray|Grau)\b/i, "Grey"],
      [/\b(?:Blue|Blau)\b/i, "Blue"],
      [/\b(?:Red|Rot)\b/i, "Red"],
      [/\b(?:Pink|Rosa)\b/i, "Pink"],
    ];
    for (const [pattern, label] of colorPatterns) {
      if (pattern.test(text)) { values["custom.color"] = label; break; }
    }
  }

  return values;
}

interface TrackedProduct {
  id: number;
  itscopeSku: string;
  itscopeProductId: string;
  shopifyProductId: string;
  distributorId: string;
  distributorName: string;
  productType: string;
  shippingMode: string;
  projectId: string | null;
  importPrice: number | null;
  lastStock: number | null;
  lastPrice: number | null;
  lastStockSync: string | null;
  priceAlert: boolean;
  active: boolean;
}

interface ItScopeOffer {
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

interface ItScopeProduct {
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
  features: Record<string, string>;
}

function ProjectIdCell({ value, onSave }: { value: string; onSave: (val: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <InlineStack gap="200" blockAlign="center">
        <div style={{ width: 120 }}>
          <TextField
            label=""
            labelHidden
            value={draft}
            onChange={setDraft}
            autoComplete="off"
            size="slim"
          />
        </div>
        <Button size="micro" onClick={() => { onSave(draft); setEditing(false); }}>Save</Button>
        <Button size="micro" variant="plain" onClick={() => { setDraft(value); setEditing(false); }}>Cancel</Button>
      </InlineStack>
    );
  }

  return (
    <InlineStack gap="200" blockAlign="center">
      <Text as="span" variant="bodySm">{value || "—"}</Text>
      <Button size="micro" variant="plain" onClick={() => setEditing(true)}>Edit</Button>
    </InlineStack>
  );
}

export default function AppPage() {
  const [skuInput, setSkuInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<ItScopeProduct | null>(null);
  const [selectedDistributor, setSelectedDistributor] = useState("");
  const [shippingMode, setShippingMode] = useState("warehouse");
  const [projectId, setProjectId] = useState("");
  const [productType, setProductType] = useState<ProductType>("Laptop");
  const [metafieldValues, setMetafieldValues] = useState<Record<string, string>>({});
  const [trackedProducts, setTrackedProducts] = useState<TrackedProduct[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [importing, setImporting] = useState(false);
  const [productsLoading, setProductsLoading] = useState(true);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [locationSaving, setLocationSaving] = useState(false);

  // Get shop from URL params (Shopify embeds the app with ?shop=...)
  const shop = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("shop") || ""
    : "";

  // Load settings and locations on mount
  useEffect(() => {
    if (shop) {
      loadTrackedProducts();
      loadSettings();
    }
  }, [shop]);

  const loadTrackedProducts = async () => {
    setProductsLoading(true);
    try {
      const res = await fetch(`/api/products?shop=${encodeURIComponent(shop)}`);
      if (res.ok) {
        const data = await res.json();
        setTrackedProducts(data);
      }
    } catch (e) {
      console.error("Failed to load products:", e);
    } finally {
      setProductsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const res = await fetch(`/api/settings?shop=${encodeURIComponent(shop)}`);
      if (res.ok) {
        const data = await res.json();
        setLocations(data.locations || []);
        if (data.selectedLocationId) {
          setSelectedLocation(data.selectedLocationId);
        } else if (data.locations?.length > 0) {
          setSelectedLocation(data.locations[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  };

  const handleSaveLocation = async () => {
    if (!selectedLocation) return;
    setLocationSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, locationId: selectedLocation }),
      });
      if (res.ok) {
        setSuccess("Inventory location saved!");
      }
    } catch (e) {
      console.error("Failed to save location:", e);
    } finally {
      setLocationSaving(false);
    }
  };

  // Auto-fill metafield values from ItScope product data
  useEffect(() => {
    if (!searchResult) return;
    const autoValues = autoFillMetafields(searchResult, productType);
    setMetafieldValues(autoValues);
  }, [productType, searchResult]);

  const handleMetafieldChange = useCallback((key: string, value: string) => {
    setMetafieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSearch = useCallback(async () => {
    if (!skuInput.trim()) return;

    setLoading(true);
    setError("");
    setSearchResult(null);
    setSelectedDistributor("");
    setProductType("Laptop");
    setMetafieldValues({});

    try {
      const res = await fetch(
        `/api/itscope-search?sku=${encodeURIComponent(skuInput.trim())}&shop=${encodeURIComponent(shop)}`
      );
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Product not found");
        return;
      }

      setSearchResult(data);
      const allowedOffers = (data.offers || []).filter((o: any) => o.available && isAllowedDistributor(o.distributorName));
      if (allowedOffers.length > 0) {
        setSelectedDistributor(allowedOffers[0].distributorId);
      }
    } catch (e: any) {
      setError(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }, [skuInput, shop]);

  const handleImport = useCallback(async () => {
    if (!searchResult || !selectedDistributor) return;

    setImporting(true);
    setError("");
    setSuccess("");

    const selectedOffer = searchResult.offers.find(
      (o) => o.distributorId === selectedDistributor
    );

    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop,
          sku: searchResult.manufacturerSku,
          distributorId: selectedDistributor,
          distributorName: selectedOffer?.distributorName || "",
          shippingMode: productType === "Warranty" ? "warehouse" : shippingMode,
          projectId: projectId.trim() || undefined,
          productType,
          metafields: metafieldValues,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const details = data.details?.map((d: any) => d.message).join("; ");
        setError(details ? `${data.error}: ${details}` : (data.error || "Import failed"));
        return;
      }

      setSuccess(`Product "${searchResult.name}" imported successfully!`);
      setSearchResult(null);
      setSkuInput("");
      setProjectId("");
      setProductType("Laptop");
      setMetafieldValues({});
      loadTrackedProducts();
    } catch (e: any) {
      setError(e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  }, [searchResult, selectedDistributor, shippingMode, projectId, shop, productType, metafieldValues]);

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await fetch("/api/products", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop, id }),
        });
        loadTrackedProducts();
      } catch (e) {
        console.error("Delete failed:", e);
      }
    },
    [shop]
  );

  const handleUpdateProjectId = useCallback(
    async (id: number, newProjectId: string) => {
      try {
        await fetch("/api/products", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop, id, projectId: newProjectId }),
        });
        loadTrackedProducts();
      } catch (e) {
        console.error("Update failed:", e);
      }
    },
    [shop]
  );

  const handleDismissPriceAlert = useCallback(
    async (id: number) => {
      try {
        await fetch("/api/products", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop, id, dismissPriceAlert: true }),
        });
        loadTrackedProducts();
      } catch (e) {
        console.error("Dismiss alert failed:", e);
      }
    },
    [shop]
  );

  const productsWithAlerts = trackedProducts.filter((p) => p.priceAlert);

  const rows = trackedProducts.map((p) => [
    p.itscopeSku,
    p.productType === "Warranty" ? (
      <Badge tone="attention">Warranty</Badge>
    ) : p.productType === "Accessory" ? (
      <Badge tone="info">Accessory</Badge>
    ) : (
      <Badge>Laptop</Badge>
    ),
    p.distributorName || p.distributorId,
    p.shippingMode === "dropship" ? (
      <Badge tone="info">Dropship</Badge>
    ) : (
      <Badge>Warehouse</Badge>
    ),
    <ProjectIdCell
      value={p.projectId || ""}
      onSave={(val) => handleUpdateProjectId(p.id, val)}
    />,
    p.lastStock !== null ? String(p.lastStock) : "—",
    p.lastPrice !== null ? (
      p.priceAlert ? (
        <InlineStack gap="200" blockAlign="center">
          <Badge tone="warning">{`€${p.lastPrice.toFixed(2)}`}</Badge>
          {p.importPrice !== null && (
            <Text as="span" variant="bodySm" tone="subdued">was €{p.importPrice.toFixed(2)}</Text>
          )}
          <Button size="micro" variant="plain" onClick={() => handleDismissPriceAlert(p.id)}>Dismiss</Button>
        </InlineStack>
      ) : (
        `€${p.lastPrice.toFixed(2)}`
      )
    ) : "—",
    p.lastStockSync
      ? new Date(p.lastStockSync).toLocaleString()
      : "Never",
    <Button variant="plain" tone="critical" onClick={() => handleDelete(p.id)}>
      Remove
    </Button>,
  ]);

  return (
    <Page title="ItScope Product Connector">
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" onDismiss={() => setError("")}>
            <p>{error}</p>
          </Banner>
        )}
        {success && (
          <Banner tone="success" onDismiss={() => setSuccess("")}>
            <p>{success}</p>
          </Banner>
        )}
        {productsWithAlerts.length > 0 && (
          <Banner tone="warning">
            <p>
              {productsWithAlerts.length} product{productsWithAlerts.length > 1 ? "s have" : " has"} a price increase from ItScope:{" "}
              {productsWithAlerts.map((p) => p.itscopeSku).join(", ")}.
              {" "}Review the prices in the table below and update your sell prices if needed.
            </p>
          </Banner>
        )}

        {locations.length > 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Inventory Location
                  </Text>
                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Select the Shopify location for ItScope inventory"
                        options={locations.map((l) => ({
                          label: l.name,
                          value: l.id,
                        }))}
                        value={selectedLocation}
                        onChange={setSelectedLocation}
                      />
                    </div>
                    <Button onClick={handleSaveLocation} loading={locationSaving}>
                      Save
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Import Product from ItScope
                </Text>
                <InlineStack gap="300" align="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Manufacturer SKU"
                      value={skuInput}
                      onChange={setSkuInput}
                      placeholder="Enter manufacturer part number (e.g., MZ-75E250B/EU)"
                      autoComplete="off"
                      connectedRight={
                        <Button
                          variant="primary"
                          onClick={handleSearch}
                          loading={loading}
                        >
                          Search
                        </Button>
                      }
                    />
                  </div>
                </InlineStack>

                {searchResult && (
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h3" variant="headingSm">
                        {searchResult.name}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {searchResult.manufacturer} — EAN: {searchResult.ean || "N/A"}
                      </Text>

                      {searchResult.offers.some((o) => o.available && isAllowedDistributor(o.distributorName)) ? (
                        <>
                          <Select
                            label="Select Distributor"
                            options={searchResult.offers
                              .filter((o) => o.available && isAllowedDistributor(o.distributorName))
                              .map((o) => ({
                                label: `${o.distributorName} — €${o.price.toFixed(2)} — ${o.stockStatusText} (${o.condition})`,
                                value: o.distributorId,
                              }))}
                            value={selectedDistributor}
                            onChange={setSelectedDistributor}
                          />

                          <Select
                            label="Product Type"
                            options={[
                              { label: "Laptop", value: "Laptop" },
                              { label: "Warranty", value: "Warranty" },
                              { label: "Accessory (Add-on)", value: "Accessory" },
                            ]}
                            value={productType}
                            onChange={(val) => setProductType(val as ProductType)}
                          />

                          <BlockStack gap="300">
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              Product Details
                            </Text>
                            {PRODUCT_TYPE_METAFIELDS[productType].map((field) => (
                              <TextField
                                key={field.key}
                                label={field.label}
                                value={metafieldValues[field.key] || ""}
                                onChange={(val) => handleMetafieldChange(field.key, val)}
                                placeholder={field.placeholder}
                                autoComplete="off"
                              />
                            ))}
                          </BlockStack>

                          {productType !== "Warranty" && (
                            <>
                              <BlockStack gap="200">
                                <Text as="p" variant="bodySm" fontWeight="semibold">
                                  Shipping Mode
                                </Text>
                                <InlineStack gap="400">
                                  <RadioButton
                                    label="Ship to Warehouse"
                                    checked={shippingMode === "warehouse"}
                                    id="warehouse"
                                    name="shippingMode"
                                    onChange={() => setShippingMode("warehouse")}
                                  />
                                  <RadioButton
                                    label="Dropshipping"
                                    checked={shippingMode === "dropship"}
                                    id="dropship"
                                    name="shippingMode"
                                    onChange={() => setShippingMode("dropship")}
                                  />
                                </InlineStack>
                              </BlockStack>

                              <TextField
                                label="Project-ID (optional)"
                                value={projectId}
                                onChange={setProjectId}
                                placeholder="ItScope project ID for special pricing"
                                autoComplete="off"
                              />
                            </>
                          )}

                          <Button
                            variant="primary"
                            onClick={handleImport}
                            loading={importing}
                          >
                            Import to Shopify
                          </Button>
                        </>
                      ) : (
                        <Banner tone="warning">
                          <p>No distributor offers found for this product.</p>
                        </Banner>
                      )}
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Tracked Products ({trackedProducts.length})
                </Text>
                {productsLoading ? (
                  <Box padding="400">
                    <InlineStack align="center">
                      <Spinner size="small" />
                    </InlineStack>
                  </Box>
                ) : trackedProducts.length > 0 ? (
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                      "text",
                      "text",
                    ]}
                    headings={[
                      "SKU",
                      "Type",
                      "Distributor",
                      "Shipping",
                      "Project-ID",
                      "Stock",
                      "Price",
                      "Last Sync",
                      "",
                    ]}
                    rows={rows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    No products tracked yet. Use the search above to import
                    products from ItScope.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
