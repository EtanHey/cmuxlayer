type Product = "brainlayer" | "voicelayer" | "cmuxlayer";

interface EcoProduct {
  name: string;
  desc: string;
  href: string;
}

const ECOSYSTEM: EcoProduct[] = [
  {
    name: "BrainLayer",
    desc: "Persistent memory for AI agents",
    href: "https://brainlayer.etanheyman.com",
  },
  {
    name: "VoiceLayer",
    desc: "Voice I/O for AI agents",
    href: "https://voicelayer.etanheyman.com",
  },
  {
    name: "cmuxLayer",
    desc: "Terminal orchestration for AI agents",
    href: "https://cmuxlayer.etanheyman.com",
  },
];

const PRODUCT_LINKS: Record<
  Product,
  { label: string; href: string; external?: boolean }[]
> = {
  voicelayer: [
    {
      label: "GitHub",
      href: "https://github.com/EtanHey/voicelayer",
      external: true,
    },
    {
      label: "Docs",
      href: "https://etanhey.github.io/voicelayer/docs/",
      external: true,
    },
    {
      label: "npm",
      href: "https://npmjs.com/package/voicelayer-mcp",
      external: true,
    },
  ],
  brainlayer: [
    {
      label: "GitHub",
      href: "https://github.com/EtanHey/brainlayer",
      external: true,
    },
    {
      label: "Docs",
      href: "https://brainlayer.etanheyman.com/docs",
      external: true,
    },
    {
      label: "PyPI",
      href: "https://pypi.org/project/brainlayer/",
      external: true,
    },
  ],
  cmuxlayer: [
    {
      label: "GitHub",
      href: "https://github.com/EtanHey/cmuxlayer",
      external: true,
    },
    {
      label: "npm",
      href: "https://github.com/EtanHey/cmuxlayer#quick-start",
      external: true,
    },
  ],
};

interface FooterProps {
  product: Product;
}

export function Footer({ product }: FooterProps) {
  const links = PRODUCT_LINKS[product];

  return (
    <footer className="py-10 border-t border-border">
      <div className="mx-auto max-w-[960px] px-6">
        {/* Ecosystem section */}
        <div className="mb-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-dim mb-4">
            Golems Ecosystem
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {ECOSYSTEM.map((p) => {
              const isCurrent = p.href.includes(product);
              return (
                <a
                  key={p.name}
                  href={isCurrent ? "#" : p.href}
                  className={`text-[13px] no-underline transition-colors ${
                    isCurrent
                      ? "text-text font-medium cursor-default"
                      : "text-text-dim hover:text-text-secondary"
                  }`}
                >
                  {p.name}
                  <span className="block text-[11px] text-text-dim font-light mt-0.5">
                    {p.desc}
                  </span>
                </a>
              );
            })}
          </div>
          <p className="text-[11px] text-text-dim font-light mt-4">
            Three open-source MCP servers. One agent toolkit.
          </p>
        </div>

        {/* Bottom row */}
        <div className="flex items-center justify-between max-md:flex-col max-md:gap-3 pt-4 border-t border-border">
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
                key={link.label}
                href={link.href}
                {...(link.external && {
                  target: "_blank",
                  rel: "noopener noreferrer",
                })}
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
