"use client";

import {
  createContext,
  useContext,
  type ReactNode,
  type CSSProperties,
} from "react";
// useContext used internally by useTerminalContext hook

/* ─── Context ─── */
interface TerminalContextValue {
  accentColor: string;
  accentBright: string;
}

const TerminalContext = createContext<TerminalContextValue>({
  accentColor: "#22c55e",
  accentBright: "#4ade80",
});

export function useTerminalContext() {
  return useTerminalContext();
}

/* ─── Root ─── */
interface TerminalRootProps {
  children: ReactNode;
  accentColor?: string;
  accentBright?: string;
  className?: string;
}

function Root({
  children,
  accentColor = "#22c55e",
  accentBright = "#4ade80",
  className = "",
}: TerminalRootProps) {
  return (
    <TerminalContext.Provider value={{ accentColor, accentBright }}>
      <div
        className={`rounded-xl overflow-hidden ${className}`}
        style={{
          background: "#0c0c0e",
          border: `1px solid rgba(255,255,255,0.06)`,
          borderTop: `1px solid ${accentColor}26`,
          boxShadow: `0 0 80px ${accentColor}0d, 0 24px 64px rgba(0,0,0,0.5)`,
        }}
      >
        {children}
      </div>
    </TerminalContext.Provider>
  );
}

/* ─── TitleBar ─── */
interface TitleBarProps {
  title: string;
}

function TitleBar({ title }: TitleBarProps) {
  return (
    <div className="flex items-center gap-[7px] px-[14px] py-[10px] bg-white/[0.025] border-b border-white/[0.05]">
      <div className="w-[11px] h-[11px] rounded-full bg-[#ff5f57]" />
      <div className="w-[11px] h-[11px] rounded-full bg-[#febc2e]" />
      <div className="w-[11px] h-[11px] rounded-full bg-[#28c840]" />
      <span className="ml-2.5 text-xs text-text-dim font-mono">{title}</span>
    </div>
  );
}

/* ─── TabBar ─── */
interface TabBarProps {
  tabs: string[];
  activeTab: string;
  onTabClick?: (tab: string) => void;
}

function TabBar({ tabs, activeTab, onTabClick }: TabBarProps) {
  const { accentColor } = useTerminalContext();

  return (
    <div className="flex bg-white/[0.02] border-b border-white/[0.04] flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabClick?.(tab)}
          className="px-3.5 py-[5px] font-mono text-[10px] border-b-2 transition-all cursor-pointer select-none"
          style={{
            color: tab === activeTab ? accentColor : "var(--color-text-dim)",
            borderBottomColor: tab === activeTab ? accentColor : "transparent",
            background: tab === activeTab ? `${accentColor}0a` : "transparent",
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

/* ─── Body ─── */
interface BodyProps {
  children?: ReactNode;
  className?: string;
  id?: string;
  style?: CSSProperties;
}

function Body({ children, className = "", id, style }: BodyProps) {
  return (
    <div
      id={id}
      className={`flex-1 p-[10px_12px] font-mono text-[11.5px] leading-[1.7] overflow-y-auto overflow-x-hidden whitespace-pre-wrap text-text-secondary max-h-[340px] ${className}`}
      style={{
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(34,197,94,0.2) transparent",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─── StatusBar ─── */
interface StatusBarProps {
  children: ReactNode;
  className?: string;
}

function StatusBar({ children, className = "" }: StatusBarProps) {
  const { accentColor } = useTerminalContext();

  return (
    <div
      className={`flex items-center gap-3.5 px-3 py-1 font-mono text-[10px] text-text-dim ${className}`}
      style={{
        background: `${accentColor}0a`,
        borderTop: `1px solid ${accentColor}1a`,
      }}
    >
      {children}
    </div>
  );
}

/* ─── StatusDot ─── */
function StatusDot({ color = "var(--color-accent)" }: { color?: string }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full mr-1"
      style={{ background: color }}
    />
  );
}

/* ─── PaneBar ─── */
interface PaneBarProps {
  title: string;
  meta?: string;
}

function PaneBar({ title, meta }: PaneBarProps) {
  const { accentColor } = useTerminalContext();

  return (
    <div className="flex items-center px-3 py-[5px] bg-white/[0.02] border-b border-white/[0.04] font-mono text-[10px]">
      <span style={{ color: accentColor }} className="font-medium">
        {title}
      </span>
      {meta && (
        <span className="ml-auto text-text-dim text-[10px]">{meta}</span>
      )}
    </div>
  );
}

/* ─── Compound Export ─── */
export const Terminal = {
  Root,
  TitleBar,
  TabBar,
  Body,
  StatusBar,
  StatusDot,
  PaneBar,
};
