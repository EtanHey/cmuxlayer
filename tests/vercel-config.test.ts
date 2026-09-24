import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vercel configuration ownership", () => {
  it("keeps the site-owned config and deletes the byte-identical root copy", () => {
    const root = join(import.meta.dirname, "..");
    expect(existsSync(join(root, "site", "vercel.json"))).toBe(true);
    expect(existsSync(join(root, "vercel.json"))).toBe(false);
  });

  it("keeps one website: site/ on Vercel, no landing/ or GitHub Pages deploy (#804)", () => {
    const root = join(import.meta.dirname, "..");
    expect(existsSync(join(root, "landing"))).toBe(false);
    expect(existsSync(join(root, ".github", "workflows", "pages.yml"))).toBe(false);

    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).not.toMatch(/upload-pages-artifact|landing\b/);
    // build-site stays a required check on the Next.js site.
    const buildSite = ci.match(/\n  build-site:\n[\s\S]*?(?=\n  [a-z][\w-]*:\n)/)?.[0] ?? "";
    expect(buildSite).toMatch(/working-directory:\s*site\b/);
    expect(buildSite).toContain("- run: npm ci");
    expect(buildSite).toContain("- run: npm run build");
  });
});
