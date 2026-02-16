import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ItScope Shopify Connector",
  description: "Connect ItScope products with your Shopify store",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
