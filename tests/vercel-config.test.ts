import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vercel configuration ownership", () => {
  it("keeps the site-owned config and deletes the byte-identical root copy", () => {
    const root = join(import.meta.dirname, "..");
    expect(existsSync(join(root, "site", "vercel.json"))).toBe(true);
    expect(existsSync(join(root, "vercel.json"))).toBe(false);
  });

  it("checks the static artifact that GitHub Pages actually deploys", () => {
    const root = join(import.meta.dirname, "..");
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const pages = readFileSync(
      join(root, ".github", "workflows", "pages.yml"),
      "utf8",
    );

    expect(pages).toMatch(/path:\s*landing\b/);
    expect(ci).toContain("run: test -s landing/index.html");
    expect(ci).toContain("uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa");
    expect(ci).toMatch(/Package exact GitHub Pages artifact[\s\S]*?path:\s*landing\b/);
  });
});
