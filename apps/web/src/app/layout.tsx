import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL ?? "https://opendiscord.app"),
  title: { default: "openDiscord — Communities belong to everyone", template: "%s · openDiscord" },
  description:
    "openDiscord is an open-source community platform. Use opendiscord.app or run the same release on your own server.",
  openGraph: { title: "openDiscord", description: "Communities belong to everyone.", siteName: "openDiscord" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${inter.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-brand-charcoal font-sans text-white">{children}</body>
    </html>
  );
}
