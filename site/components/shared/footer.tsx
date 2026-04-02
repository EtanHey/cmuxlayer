type Product = "brainlayer" | "voicelayer" | "cmuxlayer";

interface EcosystemProduct {
  name: string;
  tagline: string;
  href: string;
  accent: string;
}

const ECOSYSTEM: Record<Product, EcosystemProduct[]> = {
  cmuxlayer: [
    {
      name: "BrainLayer",
      tagline: "Persistent memory for AI agents",
      href: "https://brainlayer.etanheyman.com",
      accent: "#d4956a",
    },
    {
      name: "VoiceLayer",
      tagline: "Voice I/O for AI agents",
      href: "https://voicelayer.etanheyman.com",
      accent: "#38BDF8",
    },
  ],
  voicelayer: [
    {
      name: "BrainLayer",
      tagline: "Persistent memory for AI agents",
      href: "https://brainlayer.etanheyman.com",
      accent: "#d4956a",
    },
    {
      name: "cmuxLayer",
      tagline: "Agent orchestration across terminals",
      href: "https://cmuxlayer.etanheyman.com",
      accent: "#22c55e",
    },
  ],
  brainlayer: [
    {
      name: "VoiceLayer",
      tagline: "Voice I/O for AI agents",
      href: "https://voicelayer.etanheyman.com",
      accent: "#38BDF8",
    },
    {
      name: "cmuxLayer",
      tagline: "Agent orchestration across terminals",
      href: "https://cmuxlayer.etanheyman.com",
      accent: "#22c55e",
    },
  ],
};

const PRODUCT_LINKS: Record<Product, { label: string; href: string }[]> = {
  cmuxlayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/cmuxlayer" },
    { label: "npm", href: "https://github.com/EtanHey/cmuxlayer#install" },
  ],
  voicelayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/voicelayer" },
    { label: "npm", href: "https://npmjs.com/package/voicelayer-mcp" },
  ],
  brainlayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/brainlayer" },
    { label: "PyPI", href: "https://pypi.org/project/brainlayer/" },
  ],
};

interface FooterProps {
  product: Product;
}

export function Footer({ product }: FooterProps) {
  const siblings = ECOSYSTEM[product];
  const links = PRODUCT_LINKS[product];

  return (
    <footer className="border-t border-border">
      {/* Ecosystem section */}
      <div className="max-w-[960px] mx-auto px-6 py-10">
        <div className="text-[11px] uppercase tracking-[0.1em] text-text-dim mb-5 font-medium text-center">
          Golems Ecosystem
        </div>
        <div className="flex justify-center gap-8 max-md:flex-col max-md:items-center max-md:gap-4">
          {siblings.map((sib) => (
            <a
              key={sib.href}
              href={sib.href}
              className="group flex flex-col items-center gap-1 no-underline"
            >
              <span
                className="text-sm font-medium transition-colors"
                style={{ color: sib.accent }}
              >
                {sib.name}
              </span>
              <span className="text-[12px] text-text-dim group-hover:text-text-secondary transition-colors">
                {sib.tagline}
              </span>
            </a>
          ))}
        </div>
        <p className="text-[12px] text-text-dim text-center mt-6 font-light">
          Three open-source MCP servers. One agent toolkit.
        </p>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-border">
        <div className="max-w-[960px] mx-auto px-6 py-5 flex items-center justify-between max-md:flex-col max-md:gap-3">
          <div className="text-[13px] text-text-dim font-light">
            Built by{" "}
            <a
              href="https://etanheyman.com"
              className="text-text-secondary no-underline hover:text-accent transition-colors"
            >
              Etan Heyman
            </a>
          </div>
          <div className="flex gap-5">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-[13px] text-text-dim no-underline hover:text-text-secondary transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
