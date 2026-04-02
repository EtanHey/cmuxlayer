const withoutItems = [
  "Alt-tab between 5 terminal windows",
  "Copy-paste output from one agent to another",
  "Manually check if each agent finished",
  "One agent at a time, sequential work",
  "~142ms per CLI subprocess call",
];

const withItems = [
  "All agents visible in one split workspace",
  "One agent reads another's screen directly",
  "Auto-monitor with parsed status and done signals",
  "Parallel multi-agent orchestration",
  "0.1ms persistent socket (1,423x faster)",
];

function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="shrink-0 mt-[3px]"
    >
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 mt-[3px]"
    >
      <path d="M2.5 7.5l3 3 6-6" />
    </svg>
  );
}

export function Comparison() {
  return (
    <section className="py-[100px]">
      <div className="max-w-[960px] mx-auto px-6">
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium">
          The status quo
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-[-0.025em] text-center mb-4 leading-[1.15]">
          You are the bottleneck
        </h2>
        <p className="text-[15px] text-text-secondary text-center max-w-[520px] mx-auto mb-14 font-light leading-[1.6]">
          Four AI agents in four terminals. You&apos;re the message bus, the
          clipboard, and the status checker. That&apos;s not orchestration
          &mdash; that&apos;s overhead.
        </p>

        <div className="grid grid-cols-2 gap-4 max-w-[780px] mx-auto max-md:grid-cols-1">
          {/* WITHOUT */}
          <div className="rounded-xl border border-border bg-bg-card p-6">
            <div className="flex items-center gap-2 mb-5">
              <span className="text-xs font-mono uppercase tracking-[0.1em] text-red font-medium">
                Without cmuxLayer
              </span>
            </div>
            <div className="flex flex-col gap-3.5">
              {withoutItems.map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <span className="text-red">
                    <XIcon />
                  </span>
                  <span className="text-[13.5px] text-text-secondary font-light leading-[1.5]">
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* WITH */}
          <div
            className="rounded-xl border border-accent/20 p-6"
            style={{
              background:
                "linear-gradient(135deg, rgba(34,197,94,0.04) 0%, rgba(9,9,11,1) 100%)",
            }}
          >
            <div className="flex items-center gap-2 mb-5">
              <span className="text-xs font-mono uppercase tracking-[0.1em] text-accent font-medium">
                With cmuxLayer
              </span>
            </div>
            <div className="flex flex-col gap-3.5">
              {withItems.map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <span className="text-accent">
                    <CheckIcon />
                  </span>
                  <span className="text-[13.5px] text-text font-light leading-[1.5]">
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[13px] text-text-dim text-center mt-8 max-w-[480px] mx-auto font-light leading-[1.6]">
          Use raw tmux if you run a single agent in a single session. Use
          cmuxLayer when you need agents to see each other&apos;s work.
        </p>
      </div>
    </section>
  );
}
