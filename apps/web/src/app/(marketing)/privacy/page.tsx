import type { Metadata } from "next";
import { Suspense } from "react";
import { LegalDocument } from "@/components/marketing/legal-document";

export const metadata: Metadata = { title: "Privacy notice" };
export default function Page() {
  return <Suspense><LegalDocument kind="privacy" /></Suspense>;
}
