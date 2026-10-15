import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireBot } from "@/server/integrations";

/** The bot behind the token. */
export async function GET(request: Request) {
  try {
    const { userId } = await requireBot(request.headers);
    const [me] = await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, userId));
    return Response.json(me, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
