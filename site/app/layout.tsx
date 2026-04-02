import type { Metadata } from "next";
import { Newsreader, Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const newsreader = Newsreader({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
  weight: ["400", "600", "700"],
});

const outfit = Outfit({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://cmuxlayer.etanheyman.com"),
  alternates: { canonical: "/" },
  title: "cmuxLayer — Terminal MCP for AI Agents",
  description:
    "MCP server that gives AI agents programmatic control over terminal panes. 22 tools. Split, read, send, automate. One Unix socket.",
  openGraph: {
    title: "cmuxLayer — Terminal MCP for AI Agents",
    description:
      "22 MCP tools. 0.2ms socket latency. Spawn agents, split panes, read screens. One Unix socket.",
    url: "https://cmuxlayer.etanheyman.com",
    siteName: "cmuxLayer",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "cmuxLayer — Terminal orchestration for AI agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "cmuxLayer — Terminal MCP for AI Agents",
    description:
      "22 MCP tools. 0.2ms socket latency. Spawn agents, split panes, read screens.",
    images: ["/og.png"],
  },
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2309090b'/%3E%3Crect x='3' y='3' width='12' height='26' rx='2' stroke='%2322c55e' stroke-width='2' fill='none'/%3E%3Crect x='17' y='3' width='12' height='12' rx='2' stroke='%2322c55e' stroke-width='2' fill='none'/%3E%3Crect x='17' y='17' width='12' height='12' rx='2' stroke='%2322c55e' stroke-width='2' fill='none'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${outfit.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
