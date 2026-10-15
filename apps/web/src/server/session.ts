import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { AccountBlocked, assertActiveUser } from "./instance-policy";
import { AppError } from "./errors";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  sessionId: string;
}

async function readUser(source: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: source });
  if (!session) return null;
  const { id, name, email } = session.user;
  await assertActiveUser(id);
  return { id, name, email, sessionId: session.session.id };
}

/** For pages: signed-out visitors go to sign-in. Cached per request. */
export const requirePageUser = cache(async (): Promise<SessionUser> => {
  let user: SessionUser | null;
  try { user = await readUser(await headers()); } catch (error) {
    if (error instanceof AccountBlocked) redirect(`/sign-in?error=${error.state}`);
    throw error;
  }
  if (!user) redirect("/sign-in");
  return user;
});

/** For server actions and route handlers. */
export async function requireUser(source?: Headers): Promise<SessionUser> {
  const user = await readUser(source ?? (await headers()));
  if (!user) throw new AppError("unauthorized", "Please sign in again.");
  return user;
}
