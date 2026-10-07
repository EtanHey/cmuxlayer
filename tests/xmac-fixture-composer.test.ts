import { expect, it } from "vitest";
import { createFixtureComposer } from "../scripts/xmac/fixture-composer.mjs";
function fixture() {
  const scheduled: any[] = [], accepted: string[] = [];
  const composer = createFixtureComposer({ schedule: (fn: any, ms: number) => scheduled.push({ fn, ms }), accepted: (text: string) => accepted.push(text) });
  return { ...composer, scheduled, accepted, advance: () => scheduled.shift()?.fn() };
}
it("replies only to submitted input and retains an unsubmitted engine contract draft", () => {
  const f = fixture(); f.input("Reply exactly BOOT. Use no tools.\r");
  f.input("cmuxlayer contract for fixture: Read and follow /scratch/fixture/contract.md");
  expect(f.accepted).toEqual(["Reply exactly BOOT. Use no tools."]);
  f.advance(); f.advance();
  expect(f.state.replies).toEqual(["BOOT"]);
  expect(f.state.draft).toContain("cmuxlayer contract for fixture");
  expect(f.state.phase).toBe("idle");
});
it("preserves every repeated reply as a distinct accepted turn", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) { f.input("Reply exactly REPEATED. Use no tools.\r"); f.advance(); f.advance(); }
  expect(f.state.replies).toEqual(["REPEATED", "REPEATED"]);
  expect(f.accepted).toHaveLength(2);
});
it.each([["\r", "steer"], ["\t", "queue"]])("keeps busy %s input pending until the scheduled boundary", (key, mode) => {
  const f = fixture(); f.input("Run sleep 10 then reply BUSY_DONE.\r"); f.advance();
  f.input(`Reply exactly FOLLOWUP. Use no tools.${key}`);
  expect(f.state.pending).toEqual([{ text: "Reply exactly FOLLOWUP. Use no tools.", mode }]);
  expect(f.state.replies).toEqual([]);
  expect(f.accepted).toEqual(["Run sleep 10 then reply BUSY_DONE."]);
  f.advance(); f.advance(); f.advance();
  expect(f.state.pending).toEqual([]);
  expect(f.state.replies).toEqual(["BUSY_DONE", "FOLLOWUP"]);
  expect(f.accepted).toHaveLength(2);
});
it("does not submit an empty Return or bracketed paste delimiters", () => {
  const f = fixture(); f.input("\r\x1b[200~Reply exactly WORDS. Use no tools.\x1b[201~");
  expect(f.accepted).toEqual([]); expect(f.state.draft).toBe("Reply exactly WORDS. Use no tools.");
});
