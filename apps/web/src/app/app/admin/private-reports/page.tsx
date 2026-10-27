import { redirect } from "next/navigation";

// Private message reports moved into the Reports tab; keeps old links working.
export default function PrivateReportsPage() {
  redirect("/app/admin?tab=reports&status=private");
}
