"use client";

import { useEffect, useState } from "react";

type Product = "brainlayer" | "voicelayer" | "cmuxlayer";

const PRODUCTS: Record<
  Product,
  { label: string; accent: string; url: string; github: string }
> = {
  brainlayer: {
    label: "BrainLayer",
    accent: "#d4956a",
    url: "https://brainlayer.etanheyman.com",
    github: "https://github.com/EtanHey/brainlayer",
  },
  voicelayer: {
    label: "VoiceLayer",
    accent: "#38BDF8",
    url: "https://voicelayer.etanheyman.com",
    github: "https://github.com/EtanHey/voicelayer",
  },
  cmuxlayer: {
    label: "cmuxLayer",
    accent: "#22c55e",
    url: "https://cmuxlayer.etanheyman.com",
    github: "https://github.com/EtanHey/cmuxlayer",
  },
};

interface NavProps {
  product: Product;
  links?: { label: string; href: string }[];
}

export function Nav({ product, links = [] }: NavProps) {
  const [scrolled, setScrolled] = useState(false);
  const current = PRODUCTS[product];

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 py-4 backdrop-blur-2xl transition-[border-color] duration-300 ${
        scrolled ? "border-b border-border" : "border-b border-transparent"
      }`}
      style={{ background: "rgba(9, 9, 11, 0.8)" }}
    >
      <div className="max-w-[960px] mx-auto px-6 flex items-center justify-between">
        <a
          href="#"
          className="font-mono font-medium text-[15px] tracking-tight opacity-90 hover:opacity-100 transition-opacity no-underline text-text"
        >
          <span style={{ color: current.accent }}>
            {product === "cmuxlayer" ? "cmux" : current.label.slice(0, -5)}
          </span>
          {product === "cmuxlayer" ? "Layer" : "Layer"}
        </a>

        <div className="flex items-center gap-6">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-text-secondary no-underline text-sm hover:text-text transition-colors hidden md:inline"
            >
              {link.label}
            </a>
          ))}
          <a
            href={current.github}
            className="group text-text-secondary no-underline text-sm hover:text-text transition-colors inline-flex items-center gap-1.5"
          >
            GitHub{" "}
            <span className="inline-block transition-transform group-hover:translate-x-0.5">
              &#8599;
            </span>
          </a>
        </div>
      </div>
    </nav>
  );
}
