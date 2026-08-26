import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vercel configuration ownership", () => {
  it("keeps the site-owned config and deletes the byte-identical root copy", () => {
    const root = join(import.meta.dirname, "..");
    expect(existsSync(join(root, "site", "vercel.json"))).toBe(true);
    expect(existsSync(join(root, "vercel.json"))).toBe(false);
  });
});
