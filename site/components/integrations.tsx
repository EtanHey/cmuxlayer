"use client";

import { useState } from "react";
import Image from "next/image";

interface Agent {
  name: string;
  logo: string;
  alt: string;
}

const agents: Agent[] = [
  { name: "Claude Code", logo: "/logos/claude.svg", alt: "Claude Code" },
  { name: "Cursor", logo: "/logos/cursor.svg", alt: "Cursor" },
  { name: "Codex", logo: "/logos/openai.svg", alt: "Codex" },
  { name: "Gemini CLI", logo: "/logos/gemini.svg", alt: "Gemini CLI" },
  { name: "Kiro", logo: "/logos/kiro.svg", alt: "Kiro" },
];

interface SetupStep {
  num: string;
  text: string;
  code: string | null;
  copyText: string | null;
}

const setupSteps: SetupStep[] = [
  {
    num: "01",
    text: "Install from npm",
    code: "npm install -g cmuxlayer",
    copyText: "npm install -g cmuxlayer",
  },
  {
    num: "02",
    text: "Add to your MCP config",
    code: '"cmuxlayer": { "command": "cmuxlayer" }',
    copyText: '"cmuxlayer": { "command": "cmuxlayer" }',
  },
  {
    num: "03",
    text: "Ask your agent to split a pane",
    code: null,
    copyText: null,
  },
];

function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M5 11H3.5A1.5 1.5 0 012 9.5v-6A1.5 1.5 0 013.5 2h6A1.5 1.5 0 0111 3.5V5" />
    </svg>
  );
}

function SetupCard({ step }: { step: SetupStep }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!step.copyText) return;
    navigator.clipboard.writeText(step.copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="text-left">
      <div className="font-mono text-[13px] font-medium text-accent mb-2.5">
        {step.num}
      </div>
      <div className="text-sm text-text-secondary leading-[1.6] font-light mb-2.5">
        {step.text}
      </div>
      {step.code ? (
        <div
          className="flex items-center gap-2 bg-bg-card border border-border rounded-[6px] overflow-hidden whitespace-nowrap px-3 py-2 font-mono text-xs text-text cursor-pointer transition-[border-color] duration-200 hover:border-accent"
          onClick={handleCopy}
        >
          <span className="flex-1 min-w-0 truncate">{step.code}</span>
          <span className="text-text-dim transition-colors duration-200 shrink-0 flex items-center justify-center hover:text-accent">
            {copied ? (
              <span className="text-[11px] text-accent font-mono">copied</span>
            ) : (
              <CopyIcon />
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-bg-card border border-border rounded-[6px] overflow-hidden whitespace-nowrap px-3 py-2 font-mono text-xs cursor-default">
          <span className="flex-1 min-w-0 truncate text-accent">
            It just works.
          </span>
        </div>
      )}
    </div>
  );
}

export function Integrations() {
  return (
    <section className="py-20 pb-[100px] text-center" id="setup">
      <div className="max-w-[960px] mx-auto px-6">
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium">
          Compatible with
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-[-0.025em] text-center mb-14 leading-[1.15]">
          Five CLI agents
        </h2>

        {/* Logo row */}
        <div className="flex justify-center gap-10 flex-wrap mb-16 max-md:gap-6">
          {agents.map((agent) => (
            <div
              key={agent.name}
              className="flex flex-col items-center gap-2.5 transition-transform duration-200 hover:-translate-y-[3px] group"
            >
              <div className="w-[52px] h-[52px] rounded-xl bg-bg-card border border-border flex items-center justify-center p-[11px] transition-[border-color] duration-250 group-hover:border-accent">
                <Image
                  src={agent.logo}
                  alt={agent.alt}
                  width={30}
                  height={30}
                  className="w-full h-full object-contain"
                />
              </div>
              <span className="text-xs text-text-dim transition-colors duration-200 group-hover:text-text-secondary">
                {agent.name}
              </span>
            </div>
          ))}
        </div>

        {/* Setup section */}
        <div className="text-[11px] uppercase tracking-[0.12em] text-accent mb-3 text-center font-medium">
          Get started
        </div>
        <h2 className="font-display text-[clamp(26px,3.5vw,36px)] font-semibold tracking-[-0.025em] text-center mb-14 leading-[1.15]">
          Three steps
        </h2>

        <div className="grid grid-cols-3 gap-6 max-w-[780px] mx-auto max-md:grid-cols-1">
          {setupSteps.map((step) => (
            <SetupCard key={step.num} step={step} />
          ))}
        </div>
      </div>
    </section>
  );
}
