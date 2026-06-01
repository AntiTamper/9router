import ApiKeyPageClient from "./ApiKeyPageClient";

export const metadata = {
  title: "9Router - API Key",
  description: "Check your 9Router API key usage, quotas, and available models.",
};

export default function ApiKeyPage() {
  return <ApiKeyPageClient />;
}