import { Nav } from "@/components/shared/nav";
import { Hero } from "@/components/hero";
import { StatStrip } from "@/components/stat-strip";
import { Terminal } from "@/components/terminal";
import { Pipeline } from "@/components/pipeline";
import { Tools } from "@/components/tools";
import { Integrations } from "@/components/integrations";
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
        ]}
      />
      <Hero />
      <StatStrip />
      <Divider />
      <Terminal />
      <Divider />
      <Pipeline />
      <Divider />
      <Tools />
      <Divider />
      <Integrations />
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
