import Link from "next/link";
import { AuthCard } from "@/components/app/auth-card";

export default function NotFound() {
  return (
    <AuthCard title="This page could not be found" description="It may have been deleted, or you no longer have access.">
      <Link href="/app" className="link">Go to your communities</Link>
    </AuthCard>
  );
}
