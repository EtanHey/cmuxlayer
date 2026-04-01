type Product = "brainlayer" | "voicelayer" | "cmuxlayer";

const SIBLING_LINKS: Record<Product, { label: string; href: string }[]> = {
  cmuxlayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/cmuxlayer" },
    { label: "npm", href: "https://github.com/EtanHey/cmuxlayer#install" },
    { label: "VoiceLayer", href: "https://voicelayer.etanheyman.com" },
    { label: "BrainLayer", href: "https://brainlayer.etanheyman.com" },
  ],
  voicelayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/voicelayer" },
    { label: "npm", href: "https://npmjs.com/package/voicelayer-mcp" },
    { label: "cmuxLayer", href: "https://cmuxlayer.etanheyman.com" },
    { label: "BrainLayer", href: "https://brainlayer.etanheyman.com" },
  ],
  brainlayer: [
    { label: "GitHub", href: "https://github.com/EtanHey/brainlayer" },
    { label: "PyPI", href: "https://pypi.org/project/brainlayer/" },
    { label: "cmuxLayer", href: "https://cmuxlayer.etanheyman.com" },
    { label: "VoiceLayer", href: "https://voicelayer.etanheyman.com" },
  ],
};

interface FooterProps {
  product: Product;
}

export function Footer({ product }: FooterProps) {
  const links = SIBLING_LINKS[product];

  return (
    <footer className="py-8 border-t border-border">
      <div className="max-w-[960px] mx-auto px-6 flex items-center justify-between max-md:flex-col max-md:gap-3">
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
    </footer>
  );
}
