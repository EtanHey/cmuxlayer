import { Nav } from "@/components/shared/nav";
import { Hero } from "@/components/hero";
import { StatStrip } from "@/components/stat-strip";
import { Comparison } from "@/components/comparison";
import { Terminal } from "@/components/terminal";
import { Pipeline } from "@/components/pipeline";
import { Tools } from "@/components/tools";
import { Integrations } from "@/components/integrations";
import { AnimatedDemo } from "@/components/animated-demo";
import { Cta } from "@/components/cta";
import { Footer } from "@/components/shared/footer";

export default function Home() {
  return (
    <>
      <Nav
        product="cmuxlayer"
        links={[
          { label: "Tools", href: "#tools" },
          { label: "Setup", href: "#setup" },
          {
            label: "Docs",
            href: "https://github.com/EtanHey/cmuxlayer#readme",
          },
        ]}
      />
      <Hero />
      <StatStrip />
      <Divider />
      <Comparison />
      <Divider />
      <Terminal />
      <Divider />
      <Pipeline />
      <Divider />
      <Tools />
      <Divider />
      <Integrations />
      <Divider />
      <AnimatedDemo />
      <Divider />
      <Cta />
      <Footer product="cmuxlayer" />
    </>
  );
}

function Divider() {
  return (
    <div className="mx-auto max-w-[960px] px-6">
      <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />
    </div>
  );
}
