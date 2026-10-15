import type { Metadata } from "next";
import { Suspense } from "react";
import { LegalDocument } from "@/components/marketing/legal-document";

export const metadata: Metadata = { title: "Terms of use" };
export default function Page() {
  return <Suspense><LegalDocument kind="terms" /></Suspense>;
}
