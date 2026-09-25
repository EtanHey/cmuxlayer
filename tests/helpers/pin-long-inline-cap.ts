import { afterAll } from "vitest";

// #837 lowered the default inline cap to 500 UTF-8 bytes. The suites that
// import this exercise long-text delivery mechanics (chunked paste, Codex queue
// receipts, the dense-run policy that sits below the general cap) with
// 600-2,000 character payloads. They pin the pre-#837 cap through the supported
// CMUXLAYER_MAX_INLINE_CHARS override so they keep testing those mechanics; the
// 500-byte default itself is pinned in tests/inline-cap-bytes.test.ts.
// Import this FIRST: the cap is read when src/delivery/input-policy.ts loads.
const previous = process.env.CMUXLAYER_MAX_INLINE_CHARS;
export const PINNED_LONG_INLINE_CAP = "1800";
process.env.CMUXLAYER_MAX_INLINE_CHARS = PINNED_LONG_INLINE_CAP;

afterAll(() => {
  if (previous === undefined) delete process.env.CMUXLAYER_MAX_INLINE_CHARS;
  else process.env.CMUXLAYER_MAX_INLINE_CHARS = previous;
});
