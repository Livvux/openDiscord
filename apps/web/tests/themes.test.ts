import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_KEY, THEMES, themeScript } from "@/lib/themes";

/** Runs the pre-paint script against a stored value and returns the resulting data-theme. */
function runScript(stored: string | null): string | undefined {
  const documentElement = { dataset: {} as Record<string, string> };
  const localStorage = { getItem: (key: string) => (key === THEME_KEY ? stored : null) };
  new Function("localStorage", "document", themeScript)(localStorage, { documentElement });
  return documentElement.dataset.theme;
}

describe("themes", () => {
  it("applies a stored non-default theme before paint", () => {
    expect(runScript("discord")).toBe("discord");
  });

  it("leaves the default theme and unknown values untouched", () => {
    expect(runScript("default")).toBeUndefined();
    expect(runScript("<script>")).toBeUndefined();
    expect(runScript(null)).toBeUndefined();
  });

  it("has a CSS block for every non-default theme", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    for (const { id } of THEMES.slice(1)) expect(css).toContain(`.dark[data-theme="${id}"]`);
  });
});
