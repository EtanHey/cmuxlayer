export function Terminal() {
  return (
    <section className="py-12 pb-[100px]">
      <div className="max-w-[1200px] mx-auto px-6">
        <div className="bg-[#0c0c0e] border border-[rgba(255,255,255,0.06)] border-t-[rgba(34,197,94,0.15)] rounded-2xl overflow-hidden max-w-[820px] mx-auto relative">
          {/* Fade-out gradient at bottom */}
          <div className="absolute bottom-0 left-0 right-0 h-[60px] bg-gradient-to-b from-transparent to-bg pointer-events-none z-10" />

          {/* Title bar */}
          <div className="flex items-center gap-[7px] px-[18px] py-[14px] bg-[rgba(255,255,255,0.03)] border-b border-[rgba(255,255,255,0.05)]">
            <div className="w-[11px] h-[11px] rounded-full bg-[#ff5f57]" />
            <div className="w-[11px] h-[11px] rounded-full bg-[#febc2e]" />
            <div className="w-[11px] h-[11px] rounded-full bg-[#28c840]" />
            <span className="text-xs text-text-dim ml-2.5 font-mono">
              claude ~ my-project
            </span>
          </div>

          {/* Terminal body */}
          <div className="px-[22px] py-5 pb-12 font-mono text-[13px] leading-[1.85] max-md:text-[11px] max-md:px-3.5 max-md:py-4 max-md:pb-10 max-md:overflow-x-auto">
            {/* Line 1: prompt */}
            <span className="block">
              <span className="t-prompt">&#10095;</span>{" "}
              <span className="text-text">
                Spawn two agents &mdash; one for the API, one for the frontend
              </span>
            </span>

            {/* Response */}
            <span className="block mt-3">
              <span className="t-body">Setting up both agents.</span>
            </span>

            {/* spawn_agent 1 */}
            <span className="block mt-3">
              <span className="t-border">&#9484;&#9472;</span>{" "}
              <span className="t-tool">spawn_agent</span>(
              <span className="t-arg">repo</span>=
              <span className="t-str">&quot;api&quot;</span>,{" "}
              <span className="t-arg">model</span>=
              <span className="t-str">&quot;sonnet&quot;</span>,{" "}
              <span className="t-arg">task</span>=
              <span className="t-str">&quot;fix rate limiter&quot;</span>)
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">agent_id:</span>
              {"  "}
              <span className="t-str">sonnet-api-1743523200-f7a2</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">surface:</span>
              {"   "}
              <span className="t-str">surface:3</span>
              {"  "}
              <span className="t-dim">state:</span>{" "}
              <span className="t-ok">creating</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9492;&#9472;</span>{" "}
              <span className="t-dim">cli: claude</span>
            </span>

            {/* spawn_agent 2 */}
            <span className="block mt-3">
              <span className="t-border">&#9484;&#9472;</span>{" "}
              <span className="t-tool">spawn_agent</span>(
              <span className="t-arg">repo</span>=
              <span className="t-str">&quot;web&quot;</span>,{" "}
              <span className="t-arg">model</span>=
              <span className="t-str">&quot;opus&quot;</span>,{" "}
              <span className="t-arg">task</span>=
              <span className="t-str">&quot;add metrics page&quot;</span>)
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">agent_id:</span>
              {"  "}
              <span className="t-str">opus-web-1743523200-b4c1</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">surface:</span>
              {"   "}
              <span className="t-str">surface:4</span>
              {"  "}
              <span className="t-dim">state:</span>{" "}
              <span className="t-ok">creating</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9492;&#9472;</span>{" "}
              <span className="t-dim">cli: claude</span>
            </span>

            {/* read_screen */}
            <span className="block mt-3">
              <span className="t-border">&#9484;&#9472;</span>{" "}
              <span className="t-tool">read_screen</span>(
              <span className="t-arg">surface</span>=
              <span className="t-str">&quot;surface:3&quot;</span>,{" "}
              <span className="t-arg">parsed_only</span>=
              <span className="t-num">true</span>)
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">agent:</span>{" "}
              <span className="t-str">claude</span>
              {"  "}
              <span className="t-dim">status:</span>{" "}
              <span className="t-ok">working</span>
              {"  "}
              <span className="t-dim">model:</span>{" "}
              <span className="t-str">claude-sonnet-4-6</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
              {"  "}
              <span className="t-dim">ctx:</span>{" "}
              <span className="t-ok">
                &#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;
              </span>
              <span className="t-dim">
                &#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;
              </span>{" "}
              <span className="t-num">54%</span>
              {"  "}
              <span className="t-dim">cost:</span>{" "}
              <span className="t-num">$0.42</span>
            </span>
            <span className="block">
              <span className="t-border">&#9474;</span>
            </span>
            <span className="block">
              <span className="t-border">&#9492;&#9472;</span>{" "}
              <span className="t-dim">parsed_only: true</span>
            </span>

            {/* Summary */}
            <span className="block mt-3">
              <span className="t-body">
                Both agents are running. The API fix is 54% through context.
              </span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
