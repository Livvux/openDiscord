import { connection } from "next/server";
import { readiness } from "@/server/health";

export async function GET() {
  await connection();
  const ready = await readiness();
  return Response.json({ status: ready ? "ready" : "unavailable" }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
