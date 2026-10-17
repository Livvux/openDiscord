import { Landing } from "@/components/marketing/landing";
import { landingMetadata } from "@/components/marketing/i18n";

export const metadata = landingMetadata("en");

export default function Home() {
  return <Landing locale="en" />;
}
