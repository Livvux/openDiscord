import { cookies, headers } from "next/headers";
import { appMessages, LOCALE_COOKIE, resolveLocale, type AppLocale, type Messages } from ".";

export async function getLocale(): Promise<AppLocale> {
  const [jar, list] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, list.get("accept-language"));
}

export async function getMessages(): Promise<Messages> {
  return appMessages[await getLocale()];
}
