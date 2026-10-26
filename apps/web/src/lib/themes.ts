/** Color themes; each id other than "default" maps to a `[data-theme]` block in globals.css. */
export const THEMES = [
  { id: "default", name: "openDiscord", swatch: ["#0f172a", "#4f46e5"] },
  { id: "discord", name: "Discord", swatch: ["#313338", "#5865f2"] },
  { id: "midnight", name: "Midnight", swatch: ["#000000", "#2563eb"] },
  { id: "forest", name: "Forest", swatch: ["#0c1411", "#047857"] },
  { id: "rose", name: "Rose", swatch: ["#1c1917", "#e11d48"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** Local preference, per browser. */
export const THEME_KEY = "opendiscord:theme";

const isTheme = (value: string | null): value is ThemeId => THEMES.some((t) => t.id === value);

export const storedTheme = (): ThemeId => {
  const value = localStorage.getItem(THEME_KEY);
  return isTheme(value) ? value : "default";
};

export function applyTheme(id: ThemeId): void {
  localStorage.setItem(THEME_KEY, id);
  document.documentElement.dataset.theme = id;
}

/** Runs before first paint so a stored theme never flashes the default. */
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(${JSON.stringify(THEMES.map((t) => t.id))}.indexOf(t)>0)document.documentElement.dataset.theme=t}catch(e){}`;
