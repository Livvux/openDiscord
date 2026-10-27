"use client";

import { createContext, useContext } from "react";
import type { AppLocale, Messages } from ".";
import { en } from "./en";

const I18n = createContext<{ locale: AppLocale; messages: Messages }>({ locale: "en", messages: en });

/** Only the active language's strings reach the browser. */
export function I18nProvider({ locale, messages, children }: { locale: AppLocale; messages: Messages; children: React.ReactNode }) {
  return <I18n.Provider value={{ locale, messages }}>{children}</I18n.Provider>;
}

export const useMessages = (): Messages => useContext(I18n).messages;
export const useLocale = (): AppLocale => useContext(I18n).locale;
