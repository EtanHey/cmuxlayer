const stats = [
  { value: "0.2ms", label: "socket latency" },
  { value: "22", label: "MCP tools" },
  { value: "5", label: "agent CLIs" },
  { value: "310", label: "tests passing" },
];

export function StatStrip() {
  return (
    <div className="max-w-[960px] mx-auto px-6">
      <div className="flex justify-center gap-12 py-12 pt-12 pb-4 flex-wrap relative max-[480px]:grid max-[480px]:grid-cols-2 max-[480px]:gap-4 max-md:gap-6">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col items-center gap-1">
            <span className="font-mono text-lg font-semibold text-accent">
              {stat.value}
            </span>
            <span className="text-xs text-text-dim font-light uppercase tracking-[0.06em] max-[480px]:text-[11px]">
              {stat.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
