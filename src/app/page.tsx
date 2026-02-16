import { redirect } from "next/navigation";

export default function Home() {
  // Root page redirects to auth - the app is meant to be embedded in Shopify
  redirect("/api/auth");
}
