import Link from "next/link";

/** Official symbol + wordmark from the brand kit. `tone` is the background it sits on. */
export function Logo({ tone = "dark", href = "/" }: { tone?: "dark" | "light"; href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2" aria-label="openDiscord home">
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation needed */}
      <img src="/brand/symbol-flat.svg" alt="" width={32} height={32} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/brand/wordmark-color-${tone}.svg`} alt="openDiscord" width={123} height={20} className="h-5 w-auto" />
    </Link>
  );
}
