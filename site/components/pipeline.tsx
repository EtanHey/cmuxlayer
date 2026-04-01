"use client";

interface PipeStep {
  icon: string;
  label: string;
  time: string;
  desc: string;
}

const steps: PipeStep[] = [
  {
    icon: ">_",
    label: "Spawn",
    time: "0.2ms",
    desc: "Pick a CLI, a repo, and a task. cmuxLayer opens the pane.",
  },
  {
    icon: "\u2551",
    label: "Split",
    time: "0.2ms",
    desc: "Terminal or browser, any direction. Surfaces stack or tile.",
  },
  {
    icon: "\u25CF",
    label: "Monitor",
    time: "live",
    desc: "Context %, cost, state, errors. Parsed from raw screen output.",
  },
  {
    icon: "\u2592",
    label: "Read",
    time: "0.2ms",
    desc: "Screen content, scrollback, or structured parsed data.",
  },
];

function ArrowSvg() {
  return (
    <div className="shrink-0 w-10 flex items-center justify-center text-border-hover mt-5 max-md:hidden">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M5 12h14m-4-4 4 4-4 4" />
      </svg>
    </div>
  );
}

export function Pipeline() {
  return (
    <section className="py-[100px]">
      <div className="max-w-[960px] mx-auto px-6">
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium">
          Workflow
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-[-0.025em] text-center mb-14 leading-[1.15]">
          Spawn. Split. Monitor. Read.
        </h2>

        <div className="flex items-start justify-center gap-0 max-w-[860px] mx-auto max-md:flex-wrap max-md:gap-4">
          {steps.map((step, i) => (
            <div key={step.label} className="contents">
              <div className="flex flex-col items-center text-center flex-1 group max-md:flex-[0_0_40%] max-[480px]:flex-[0_0_100%]">
                <div className="w-16 h-16 rounded-2xl bg-bg-card border border-[rgba(34,197,94,0.12)] flex items-center justify-center mb-3.5 font-mono text-lg text-accent transition-all duration-250 group-hover:border-accent group-hover:-translate-y-0.5">
                  {step.icon}
                </div>
                <div className="font-sans text-sm font-medium text-text mb-1">
                  {step.label}
                </div>
                <div className="font-mono text-xs text-accent font-medium">
                  {step.time}
                </div>
                <div className="text-xs text-text-dim font-light max-w-[130px] mt-1">
                  {step.desc}
                </div>
              </div>
              {i < steps.length - 1 && <ArrowSvg />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
