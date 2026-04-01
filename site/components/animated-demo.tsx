"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ── HTML color helpers ──
const c = (cls: string, text: string) => `<span class="${cls}">${text}</span>`;
const dim = (t: string) => c("c-d", t);
const grn = (t: string) => c("c-g", t);
const brg = (t: string) => c("c-gb", t);
const amb = (t: string) => c("c-a", t);
const cyn = (t: string) => c("c-c", t);
const tea = (t: string) => c("c-t", t);
const wht = (t: string) => c("c-w", t);
const sec = (t: string) => c("c-s", t);

const bullet = () => grn("\u23FA ");
const indent = () => dim("\u23BF ");
const prompt = () => grn("\u276F ");
const think = () => amb("\u273B ") + dim("Thinking...");

function statusLine(
  branch: string,
  model: string,
  tokens: string,
  cost: string,
) {
  return (
    "\n" +
    dim("\u2500".repeat(38)) +
    "\n" +
    dim("\u2387 ") +
    sec(branch) +
    "  " +
    dim("\uD83E\uDD16 ") +
    sec(model) +
    "  " +
    tea(tokens) +
    dim(" tokens") +
    "  " +
    tea(cost)
  );
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AnimatedDemo() {
  const orcRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const surfacesRef = useRef<HTMLSpanElement>(null);
  const agentsRef = useRef<HTMLSpanElement>(null);
  const latencyRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const statusBarRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Centralized agent state
  const agentState = useRef<Record<string, string>>({});
  const tabList = useRef<string[]>([]);
  const activeTab = useRef<string | null>(null);
  const userTab = useRef<string | null>(null);
  const userTabTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cronInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  function appendOrc(html: string) {
    const el = orcRef.current;
    if (!el) return;
    el.innerHTML += html + "\n";
    el.scrollTop = el.scrollHeight;
  }

  async function typeIn(el: HTMLElement, text: string, speed: number) {
    const span = document.createElement("span");
    el.appendChild(span);
    for (let i = 0; i <= text.length; i++) {
      span.innerHTML =
        esc(text.slice(0, i)) + '<span class="demo-cursor"></span>';
      el.scrollTop = el.scrollHeight;
      await sleep(speed + Math.random() * speed * 0.6);
    }
    await sleep(300);
    span.textContent = text;
  }

  function renderAgentView() {
    const tabs = tabsRef.current;
    const agent = agentRef.current;
    if (!tabs || !agent) return;

    const visible = userTab.current || activeTab.current;
    tabs.innerHTML = tabList.current
      .map(
        (t) =>
          `<div class="demo-tab${t === visible ? " active" : ""}" data-dtab="${esc(t)}" title="Click to view">${esc(t)}</div>`,
      )
      .join("");

    tabs.querySelectorAll<HTMLElement>(".demo-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        userTab.current = tab.dataset.dtab ?? null;
        if (userTabTimeout.current) clearTimeout(userTabTimeout.current);
        userTabTimeout.current = setTimeout(() => {
          userTab.current = null;
        }, 5000);
        renderAgentView();
      });
    });

    if (visible && agentState.current[visible]) {
      agent.innerHTML = agentState.current[visible];
    }
  }

  function updateAgentState(name: string, html: string) {
    agentState.current[name] = html;
    renderAgentView();
  }

  function setActiveTab(name: string) {
    activeTab.current = name;
    renderAgentView();
  }

  function setTabList(arr: string[], auto: string) {
    tabList.current = arr;
    activeTab.current = auto;
    renderAgentView();
  }

  function setStat(s: number, a: number, st: string) {
    if (surfacesRef.current) surfacesRef.current.textContent = s + " surfaces";
    if (agentsRef.current) agentsRef.current.textContent = a + " agents";
    if (statusRef.current) statusRef.current.textContent = st;
  }

  function startCron() {
    const bar = statusBarRef.current;
    if (!bar) return;
    cronInterval.current = setInterval(() => {
      bar.classList.remove("cron-flash");
      void bar.offsetWidth;
      bar.classList.add("cron-flash");
    }, 3000);
  }

  function stopCron() {
    if (cronInterval.current) {
      clearInterval(cronInterval.current);
      cronInterval.current = null;
    }
  }

  // ── The Movie Script ──
  async function runCycle() {
    const orc = orcRef.current;
    const agent = agentRef.current;
    const tabs = tabsRef.current;
    if (!orc || !agent || !tabs) return;

    // Reset
    orc.innerHTML = "";
    agentState.current = {};
    tabList.current = [];
    activeTab.current = null;
    userTab.current = null;
    if (userTabTimeout.current) {
      clearTimeout(userTabTimeout.current);
      userTabTimeout.current = null;
    }
    tabs.innerHTML = "";
    agent.innerHTML = dim("no active agents");
    setStat(2, 0, "ready");
    stopCron();

    // Phase 1 — Prompt
    appendOrc(
      grn("\u276F") +
        " " +
        wht("Deploy the voice fix and optimize brain search"),
    );
    await sleep(800);
    appendOrc("");
    await typeIn(orc, "On it. Two parallel agents for this.", 35);
    await sleep(400);

    // Phase 2 — Spawn agent 1
    appendOrc("");
    appendOrc(
      dim("\u250C\u2500") +
        " " +
        brg("spawn_agent") +
        "(" +
        cyn("repo") +
        "=" +
        amb('"voicelayer"') +
        ", " +
        cyn("model") +
        "=" +
        amb('"opus"') +
        ")",
    );
    await sleep(600);
    appendOrc(
      dim("\u2502") + "  " + dim("agent_id:") + " " + amb("opus-voice-a3f7"),
    );
    appendOrc(
      dim("\u2502") +
        "  " +
        dim("surface:") +
        "  " +
        amb("surface:3") +
        "  " +
        dim("state:") +
        " " +
        grn("creating"),
    );
    appendOrc(dim("\u2514\u2500") + " " + dim("cli: claude"));
    setStat(3, 1, "spawning");
    setTabList(["voiceFix"], "voiceFix");
    updateAgentState(
      "voiceFix",
      dim("\u256D\u2500 Claude Code v1.0.23") +
        "\n" +
        dim("\u2502 ") +
        sec("Model: claude-opus-4-6 (1M context)") +
        "\n" +
        dim("\u2502 ") +
        sec("Repo: ~/Gits/voicelayer") +
        "\n" +
        dim("\u2502 ") +
        sec("Task: Fix edge-tts fallback") +
        "\n" +
        dim("\u256E\u2500") +
        "\n\n" +
        think() +
        statusLine("main", "Opus 4.6", "0", "$0.00"),
    );
    await sleep(1200);

    // Phase 3 — Spawn agent 2
    appendOrc("");
    appendOrc(
      dim("\u250C\u2500") +
        " " +
        brg("spawn_agent") +
        "(" +
        cyn("repo") +
        "=" +
        amb('"brainlayer"') +
        ", " +
        cyn("model") +
        "=" +
        amb('"sonnet"') +
        ")",
    );
    await sleep(500);
    appendOrc(
      dim("\u2502") + "  " + dim("agent_id:") + " " + amb("sonnet-brain-c1d4"),
    );
    appendOrc(
      dim("\u2502") +
        "  " +
        dim("surface:") +
        "  " +
        amb("surface:4") +
        "  " +
        dim("state:") +
        " " +
        grn("creating"),
    );
    appendOrc(dim("\u2514\u2500") + " " + dim("cli: claude"));
    setStat(4, 2, "spawning");
    setTabList(["voiceFix", "brainOpt"], "voiceFix");
    updateAgentState(
      "brainOpt",
      dim("\u256D\u2500 Claude Code v1.0.23") +
        "\n" +
        dim("\u2502 ") +
        sec("Model: claude-sonnet-4-6 (200K context)") +
        "\n" +
        dim("\u2502 ") +
        sec("Repo: ~/Gits/brainlayer") +
        "\n" +
        dim("\u2502 ") +
        sec("Task: Optimize FTS5 search") +
        "\n" +
        dim("\u256E\u2500") +
        "\n\n" +
        think() +
        statusLine("main", "Sonnet 4.6", "0", "$0.00"),
    );
    await sleep(800);

    // Phase 3.5 — Cron
    appendOrc("");
    appendOrc(
      dim("\u250C\u2500") +
        " " +
        brg("CronCreate") +
        "(" +
        cyn("interval") +
        "=" +
        amb('"*/30s"') +
        ", " +
        cyn("cmd") +
        "=" +
        amb('"read_screen parsed_only=true"') +
        ")",
    );
    await sleep(400);
    appendOrc(
      dim("\u2514\u2500") +
        " " +
        dim("cron:") +
        " " +
        amb("cron-1") +
        "  " +
        grn("active") +
        "  " +
        dim("polling every 30s"),
    );
    startCron();
    await sleep(600);

    // Phase 4 — Agents working
    setStat(4, 2, "agents working");
    const voiceSteps = [
      {
        tok: "42K",
        cost: "$0.23",
        out:
          bullet() +
          wht("Read") +
          sec(" src/tts/edge-tts.ts") +
          "\n" +
          indent() +
          sec("Found fallback issue at line 147") +
          "\n" +
          indent() +
          sec("Stream closes without retry on timeout"),
      },
      {
        tok: "87K",
        cost: "$0.61",
        out:
          bullet() +
          wht("Edit") +
          sec(" src/tts/edge-tts.ts") +
          "\n" +
          indent() +
          grn("+ ") +
          sec("if (!stream) return fallbackToGoogleTTS(text);") +
          "\n" +
          indent() +
          grn("+ ") +
          sec('log.warn("edge-tts timeout, falling back");'),
      },
      {
        tok: "134K",
        cost: "$1.12",
        out:
          bullet() +
          wht("Bash") +
          sec(" bun test src/tts/") +
          "\n" +
          indent() +
          grn("\u2713") +
          sec(" edge-tts falls back on timeout") +
          "\n" +
          indent() +
          grn("\u2713") +
          sec(" google-tts returns audio buffer") +
          "\n" +
          indent() +
          tea("2 pass") +
          dim(" 0 fail"),
      },
    ];
    const brainSteps = [
      { tok: "31K", cost: "$0.11", out: think() },
      {
        tok: "68K",
        cost: "$0.24",
        out:
          bullet() +
          wht("Edit") +
          sec(" src/search/hybrid.ts") +
          "\n" +
          indent() +
          sec("Rewrite hybrid_search() to use pre-filtered") +
          "\n" +
          indent() +
          sec("candidate set before semantic ranking"),
      },
      {
        tok: "96K",
        cost: "$0.34",
        out:
          bullet() +
          wht("Bash") +
          sec(" bun test src/search/") +
          "\n" +
          indent() +
          grn("\u2713") +
          sec(" hybrid search returns top-3 in <11ms") +
          "\n" +
          indent() +
          sec("Benchmark: 48ms \u2192 11ms (4.3x faster)"),
      },
    ];

    setActiveTab("voiceFix");
    for (let i = 0; i < voiceSteps.length; i++) {
      const vs = voiceSteps[i];
      const bs = brainSteps[i] || brainSteps[brainSteps.length - 1];
      updateAgentState(
        "voiceFix",
        vs.out + statusLine("fix/edge-tts", "Opus 4.6", vs.tok, vs.cost),
      );
      updateAgentState(
        "brainOpt",
        bs.out + statusLine("fix/fts5-perf", "Sonnet 4.6", bs.tok, bs.cost),
      );
      await sleep(2000);
    }

    // Phase 5 — Switch to brainOpt
    setActiveTab("brainOpt");
    updateAgentState(
      "brainOpt",
      bullet() +
        wht("Edit") +
        sec(" src/search/hybrid.ts") +
        "\n" +
        indent() +
        sec("Rewrite hybrid_search() with pre-filtered") +
        "\n" +
        indent() +
        sec("candidate set before semantic ranking") +
        "\n\n" +
        bullet() +
        wht("Bash") +
        sec(" bun test src/search/") +
        "\n" +
        indent() +
        grn("\u2713") +
        sec(" hybrid search returns top-3 in <11ms") +
        "\n" +
        indent() +
        sec("Benchmark: ") +
        amb("48ms \u2192 11ms") +
        sec(" (4.3x faster)") +
        statusLine("fix/fts5-perf", "Sonnet 4.6", "96K", "$0.34"),
    );
    await sleep(3000);

    // Phase 6 — Monitor
    stopCron();
    setActiveTab("voiceFix");
    appendOrc("");
    appendOrc(
      dim("\u250C\u2500") +
        " " +
        brg("read_screen") +
        "(" +
        cyn("surface") +
        "=" +
        amb('"surface:3"') +
        ", " +
        cyn("parsed_only") +
        "=" +
        tea("true") +
        ")",
    );
    await sleep(600);
    appendOrc(
      dim("\u2502") +
        "  " +
        dim("agent:") +
        " " +
        sec("claude") +
        "  " +
        dim("status:") +
        " " +
        grn("idle") +
        "  " +
        dim("model:") +
        " " +
        sec("opus-4-6"),
    );
    appendOrc(
      dim("\u2502") +
        "  " +
        dim("tokens:") +
        " " +
        tea("142K") +
        "  " +
        dim("ctx:") +
        " " +
        tea("71%") +
        "  " +
        dim("cost:") +
        " " +
        tea("$1.12"),
    );
    appendOrc(
      dim("\u2514\u2500") + " " + grn('done_signal: "CLAUDE_COUNTER: 7"'),
    );
    await sleep(1000);

    // Phase 7 — wait_for_all
    appendOrc("");
    appendOrc(
      dim("\u250C\u2500") +
        " " +
        brg("wait_for_all") +
        "(" +
        cyn("target") +
        "=" +
        amb('"done"') +
        ")",
    );
    await sleep(800);
    appendOrc(
      dim("\u2502") +
        "  " +
        grn("\u2713") +
        " " +
        dim("opus-voice-a3f7:") +
        "  " +
        grn("done") +
        " " +
        dim("(34s)"),
    );
    await sleep(500);
    appendOrc(
      dim("\u2502") +
        "  " +
        grn("\u2713") +
        " " +
        dim("sonnet-brain-c1d4:") +
        " " +
        grn("done") +
        " " +
        dim("(51s)"),
    );
    appendOrc(dim("\u2514\u2500") + " " + grn("all agents finished"));
    setStat(4, 2, "all done");
    await sleep(1000);

    // Phase 8 — Results
    updateAgentState(
      "voiceFix",
      prompt() +
        wht("Done.") +
        "\n\n" +
        bullet() +
        wht("Bash") +
        sec(" git add src/tts/ tests/tts.test.ts") +
        "\n" +
        bullet() +
        wht("Bash") +
        sec(' git commit -m "fix: edge-tts fallback"') +
        "\n" +
        indent() +
        grn("[fix/edge-tts a3f7c21]") +
        "\n" +
        indent() +
        sec("2 files changed, +23 -4") +
        "\n\n" +
        sec("CLAUDE_COUNTER: 7") +
        statusLine("fix/edge-tts", "Opus 4.6", "142K", "$1.12"),
    );
    updateAgentState(
      "brainOpt",
      prompt() +
        wht("Done.") +
        "\n\n" +
        bullet() +
        wht("Bash") +
        sec(" git add src/search/ tests/") +
        "\n" +
        bullet() +
        wht("Bash") +
        sec(' git commit -m "perf: optimize FTS5"') +
        "\n" +
        indent() +
        grn("[fix/fts5-perf c1d4e89]") +
        "\n" +
        indent() +
        sec("2 files changed, +31 -8") +
        "\n\n" +
        sec("CLAUDE_COUNTER: 12") +
        statusLine("fix/fts5-perf", "Sonnet 4.6", "96K", "$0.34"),
    );
    setActiveTab("voiceFix");
    await sleep(1200);

    appendOrc("");
    await typeIn(orc, "Both done. Pushing PRs now.", 30);
    await sleep(500);
    appendOrc("");
    appendOrc(
      grn("\u2713") +
        " " +
        sec("voicelayer#34: ") +
        amb("fix: edge-tts fallback to google-tts"),
    );
    await sleep(400);
    appendOrc(
      grn("\u2713") +
        " " +
        sec("brainlayer#91: ") +
        amb("perf: optimize FTS5 hybrid search (4.3x)"),
    );
    await sleep(600);
    appendOrc("");
    appendOrc(
      grn("\u2501\u2501\u2501 ") +
        wht("2 agents \u00B7 2 PRs \u00B7 310 tests passing") +
        grn(" \u2501\u2501\u2501"),
    );
    setStat(4, 0, "\u2713 complete");
    await sleep(3000);
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Latency flicker
    const latencyId = setInterval(() => {
      if (latencyRef.current) {
        latencyRef.current.textContent =
          (0.1 + Math.random() * 0.2).toFixed(1) + "ms";
      }
    }, 1800);

    // Start on scroll
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (e) => {
          if (!e.isIntersecting) return;
          obs.disconnect();
          const layout = layoutRef.current;
          if (!layout) return;
          layout.style.transition = "opacity 0.6s ease";

          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            await runCycle();
            return;
          }
          while (true) {
            try {
              layout.style.opacity = "1";
              await runCycle();
              layout.style.opacity = "0.15";
              await sleep(800);
            } catch {
              await sleep(3000);
            }
          }
        });
      },
      { threshold: 0.2 },
    );

    const el = document.getElementById("animated-demo");
    if (el) obs.observe(el);

    return () => {
      clearInterval(latencyId);
      obs.disconnect();
    };
  }, []);

  return (
    <section className="py-[100px]">
      <div className="max-w-[1200px] mx-auto px-6">
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium hero-fade">
          See it work
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-tight text-center mb-14 leading-tight hero-fade hero-fade-d1">
          Two agents. One orchestrator. Zero tab-switching.
        </h2>

        <div
          id="animated-demo"
          className="max-w-[920px] mx-auto rounded-xl overflow-hidden hero-fade hero-fade-d2"
          style={{
            background: "#0a0a0c",
            border: "1px solid rgba(34,197,94,0.15)",
            boxShadow:
              "0 0 80px rgba(34,197,94,0.05), 0 24px 64px rgba(0,0,0,0.5)",
          }}
          aria-hidden="true"
        >
          {/* Title bar */}
          <div className="flex items-center gap-[7px] px-3.5 py-2.5 bg-white/[0.025] border-b border-white/[0.05]">
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[11px] text-text-dim font-mono">
              cmux &mdash; workspace:1
            </span>
          </div>

          {/* Split layout */}
          <div ref={layoutRef} className="flex min-h-[380px] max-md:flex-col">
            {/* Left: Orchestrator */}
            <div className="flex-[0_0_44%] border-r-2 border-r-[rgba(34,197,94,0.12)] flex flex-col max-md:flex-none max-md:border-r-0 max-md:border-b-2 max-md:border-b-[rgba(34,197,94,0.12)]">
              <div className="flex items-center px-3 py-[5px] bg-white/[0.02] border-b border-white/[0.04] font-mono text-[10px]">
                <span className="text-accent font-medium">orchestrator</span>
                <span className="ml-auto text-text-dim text-[10px]">
                  surface:1
                </span>
              </div>
              <div
                ref={orcRef}
                className="flex-1 p-[10px_12px] font-mono text-[11.5px] leading-[1.7] overflow-y-auto overflow-x-hidden whitespace-pre-wrap text-text-secondary max-h-[340px]"
                style={{
                  scrollbarWidth: "thin",
                  scrollbarColor: "rgba(34,197,94,0.2) transparent",
                }}
              />
            </div>

            {/* Right: Agent tabs */}
            <div className="flex-1 flex flex-col relative">
              <div
                ref={tabsRef}
                className="flex bg-white/[0.02] border-b border-white/[0.04] flex-wrap"
              />
              <div
                ref={agentRef}
                className="flex-1 p-[10px_12px] font-mono text-[11.5px] leading-[1.7] overflow-y-auto overflow-x-hidden whitespace-pre-wrap text-text-secondary max-h-[340px]"
                style={{
                  scrollbarWidth: "thin",
                  scrollbarColor: "rgba(34,197,94,0.2) transparent",
                }}
              />
            </div>
          </div>

          {/* Status bar */}
          <div
            ref={statusBarRef}
            className="flex items-center gap-3.5 px-3 py-1 font-mono text-[10px] text-text-dim"
            style={{
              background: "rgba(34,197,94,0.04)",
              borderTop: "1px solid rgba(34,197,94,0.1)",
            }}
          >
            <span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-1" />
              socket
            </span>
            <span ref={surfacesRef}>2 surfaces</span>
            <span ref={agentsRef}>0 agents</span>
            <span ref={latencyRef}>0.2ms</span>
            <span className="ml-auto" ref={statusRef}>
              ready
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
