const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue";

export const button = {
  primary: `${base} bg-ink text-canvas hover:bg-ink/85`,
  outline: `${base} border border-ink/20 bg-white text-ink hover:border-ink/40`,
  onDark: `${base} bg-canvas text-ink hover:bg-white`,
  outlineOnDark: `${base} border border-dark-line text-canvas hover:bg-white/10`,
} as const;

export const size = { sm: "h-9 px-3.5 text-sm", lg: "h-12 px-6 text-base" } as const;

/** Page gutter shared by every section so edges line up. */
export const container = "mx-auto w-full max-w-[75rem] px-6";
