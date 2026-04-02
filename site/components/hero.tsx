"use client";

import { useState } from "react";

export function Hero() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText("npm install -g cmuxlayer").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="pt-[180px] pb-12 text-center relative">
      {/* Green radial gradient background */}
      <div
        className="absolute top-[-100px] left-1/2 -translate-x-1/2 w-[800px] h-[500px] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse, rgba(34, 197, 94, 0.06) 0%, transparent 70%)",
        }}
      />

      {/* Animated pane outlines */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[55%] w-[380px] h-[240px] opacity-[0.06] pointer-events-none max-md:w-[280px] max-md:h-[180px]"
        aria-hidden="true"
      >
        <div
          className="absolute top-0 left-0 w-[54%] h-full border-2 border-accent rounded-[4px]"
          style={{ animation: "pane-pulse 3s ease-in-out infinite" }}
        >
          <div
            className="absolute top-3 left-3 w-2 h-[15px] bg-accent rounded-[1px]"
            style={{ animation: "blink 1s step-end infinite" }}
          />
        </div>
        <div
          className="absolute top-0 right-0 w-[44%] h-[47%] border-2 border-accent rounded-[4px]"
          style={{
            animation: "pane-pulse 3s ease-in-out infinite",
            animationDelay: "0.6s",
          }}
        />
        <div
          className="absolute bottom-0 right-0 w-[44%] h-[47%] border-2 border-accent rounded-[4px]"
          style={{
            animation: "pane-pulse 3s ease-in-out infinite",
            animationDelay: "1.2s",
          }}
        />
      </div>

      <div className="max-w-[960px] mx-auto px-6">
        <h1 className="font-display text-[clamp(40px,6vw,68px)] font-bold tracking-[-0.035em] leading-[1.08] mb-6 max-w-[700px] mx-auto relative hero-fade">
          One terminal.
          <br />
          <em className="italic text-accent">Many agents.</em>
        </h1>

        <p className="text-[17px] text-text-secondary max-w-[540px] mx-auto mb-4 leading-[1.65] font-light relative hero-fade hero-fade-d1">
          Claude Code in one tab, Codex in another, Gemini in a third &mdash;
          and you&apos;re the message bus between them. cmuxLayer gives AI
          agents programmatic control over terminal workspaces. Spawn, monitor,
          coordinate &mdash; all through MCP.
        </p>

        <p className="text-[13px] text-text-dim mb-10 relative hero-fade hero-fade-d1">
          free &middot; open source &middot; 22 MCP tools
        </p>

        <div className="flex items-center justify-center gap-3 mb-12 relative hero-fade hero-fade-d2 max-[480px]:flex-col">
          <a
            href="#setup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium no-underline cursor-pointer bg-text text-bg hover:scale-[1.03] active:scale-[0.98] transition-transform duration-150 hover:shadow-[0_0_24px_rgba(250,250,249,0.15)] max-[480px]:w-full max-[480px]:justify-center"
          >
            Get started
          </a>
          <a
            href="https://github.com/EtanHey/cmuxlayer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium no-underline cursor-pointer bg-transparent text-text-secondary border border-border hover:text-text hover:border-border-hover hover:scale-[1.03] active:scale-[0.98] transition-all duration-150 max-[480px]:w-full max-[480px]:justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View source
          </a>
        </div>

        <div className="max-w-[420px] mx-auto relative hero-fade hero-fade-d3">
          <div
            className="flex items-center bg-bg-card border border-border rounded-[10px] px-[18px] py-3 font-mono text-sm text-text-secondary cursor-pointer transition-[border-color] duration-250 hover:border-accent"
            onClick={handleCopy}
          >
            <code className="text-text flex-1">
              <span className="text-text-dim">$</span> npm install -g cmuxlayer
            </code>
            <button
              className="bg-transparent border-none text-text-dim cursor-pointer p-0 transition-colors duration-200 flex items-center justify-center w-6 h-6 shrink-0 hover:text-accent"
              aria-label="Copy"
            >
              {copied ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 8.5l3 3 7-7" className="text-accent" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="5" y="5" width="9" height="9" rx="1.5" />
                  <path d="M5 11H3.5A1.5 1.5 0 012 9.5v-6A1.5 1.5 0 013.5 2h6A1.5 1.5 0 0111 3.5V5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
