#!/usr/bin/env node
/**
 * Generate OG image (1200x630) as a branded social preview card.
 * Uses sharp to convert SVG → PNG.
 *
 * Usage: node scripts/generate-og.mjs
 * Output: site/public/og.png
 */

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const WIDTH = 1200;
const HEIGHT = 630;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#09090b" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#09090b"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

  <!-- Top accent line -->
  <rect x="0" y="0" width="${WIDTH}" height="4" fill="#22c55e"/>

  <!-- Pane grid decoration (subtle) -->
  <rect x="80" y="180" width="140" height="260" rx="6" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.12"/>
  <rect x="80" y="180" width="140" height="120" rx="6" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.08"/>
  <rect x="980" y="180" width="140" height="260" rx="6" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.12"/>
  <rect x="980" y="180" width="140" height="120" rx="6" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.08"/>

  <!-- Logo text -->
  <text x="600" y="250" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="82" fill="#fafaf9" letter-spacing="-2">
    <tspan fill="#22c55e">cmux</tspan><tspan fill="#fafaf9">Layer</tspan>
  </text>

  <!-- Subtitle -->
  <text x="600" y="320" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="400" font-size="32" fill="#a8a29e">
    Terminal orchestration for AI agents
  </text>

  <!-- Divider -->
  <line x1="450" y1="380" x2="750" y2="380" stroke="#22c55e" stroke-width="1" opacity="0.3"/>

  <!-- Bottom stats -->
  <text x="600" y="430" text-anchor="middle" font-family="monospace" font-weight="500" font-size="20" fill="#6b6660">
    22 MCP tools  ·  Open Source  ·  etanheyman.com
  </text>

  <!-- Bottom accent line -->
  <rect x="0" y="${HEIGHT - 4}" width="${WIDTH}" height="4" fill="#22c55e" opacity="0.6"/>
</svg>`;

// Write SVG first
const svgPath = "site/public/og.svg";
writeFileSync(svgPath, svg);

// Convert to PNG using sharp via a one-liner
try {
  execSync(
    `node -e "import('sharp').then(s => s.default('${svgPath}').resize(${WIDTH},${HEIGHT}).png().toFile('site/public/og.png').then(() => console.log('OK')))"`,
    { stdio: "inherit" }
  );
} catch {
  // Fallback: install sharp temporarily and convert
  console.log("Installing sharp...");
  execSync("npm install --no-save sharp", { stdio: "inherit" });
  execSync(
    `node -e "import('sharp').then(s => s.default('${svgPath}').resize(${WIDTH},${HEIGHT}).png().toFile('site/public/og.png').then(() => console.log('OK')))"`,
    { stdio: "inherit" }
  );
}

// Clean up SVG
execSync("rm -f site/public/og.svg");
console.log("Generated site/public/og.png (1200x630)");
