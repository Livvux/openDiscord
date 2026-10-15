import { openApiDocument } from "@/server/openapi";

export function GET() {
  return Response.json(openApiDocument, { headers: { "Cache-Control": "public, max-age=3600" } });
}
