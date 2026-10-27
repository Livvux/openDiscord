import { describe, expect, it } from "vitest";
import { de } from "@/lib/i18n/de";
import { en } from "@/lib/i18n/en";
import { fmt, resolveLocale } from "@/lib/i18n";

const keys = (o: object, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [prefix + k] : keys(v as object, `${prefix}${k}.`)));

describe("app i18n", () => {
  it("prefers the saved language, then the browser's, then English", () => {
    expect(resolveLocale("de", "en-US,en;q=0.9")).toBe("de");
    expect(resolveLocale(undefined, "fr-FR,de-DE;q=0.8,en;q=0.5")).toBe("de");
    expect(resolveLocale("xx", "fr")).toBe("en");
    expect(resolveLocale(undefined, null)).toBe("en");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(fmt("Block {name}", { name: "Ada" })).toBe("Block Ada");
    expect(fmt("{count} {missing}", { count: 3 })).toBe("3 {missing}");
  });

  it("German keeps every English placeholder", () => {
    const pick = (o: object, path: string) => path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], o) as string;
    for (const path of keys(en)) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(pick(de, path)), path).toEqual(vars(pick(en, path)));
    }
  });
});
