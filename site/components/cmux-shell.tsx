"use client";

import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Terminal } from "./shared/terminal";

interface CmuxShellProps {
  children: ReactNode;
}

/**
 * The cmuxLayer page IS a cmux window. This shell wraps the entire page
 * in a terminal chrome — title bar, workspace tabs, split pane layout.
 */
export function CmuxShell({ children }: CmuxShellProps) {
  return <div className="min-h-screen flex flex-col">{children}</div>;
}

/* ─── Workspace Tab Bar ─── */
interface WorkspaceTab {
  id: string;
  label: string;
}

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function WorkspaceTabBar({
  tabs,
  activeTab,
  onTabChange,
}: WorkspaceTabBarProps) {
  return (
    <div className="flex bg-white/[0.015] border-b border-white/[0.04]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className="px-4 py-[6px] font-mono text-[11px] border-b-2 transition-all cursor-pointer select-none"
          style={{
            color:
              tab.id === activeTab
                ? "var(--color-accent)"
                : "var(--color-text-dim)",
            borderBottomColor:
              tab.id === activeTab ? "var(--color-accent)" : "transparent",
            background:
              tab.id === activeTab ? "rgba(34,197,94,0.03)" : "transparent",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ─── Split Pane ─── */
interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  leftWidth?: string;
}

export function SplitPane({ left, right, leftWidth = "44%" }: SplitPaneProps) {
  return (
    <div className="flex min-h-[380px] max-md:flex-col">
      <div
        className="flex flex-col max-md:flex-none max-md:border-b-2 max-md:border-b-accent/10 border-r-2 border-r-accent/10"
        style={{ flex: `0 0 ${leftWidth}` }}
      >
        {left}
      </div>
      <div className="flex-1 flex flex-col relative">{right}</div>
    </div>
  );
}

/* ─── Animated Pane Content ─── */
interface AnimatedPaneProps {
  children: ReactNode;
  tabKey: string;
}

export function AnimatedPane({ children, tabKey }: AnimatedPaneProps) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={tabKey}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="flex-1"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
