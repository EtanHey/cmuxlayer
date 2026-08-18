import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TICKET_DIR = join(homedir(), ".cmuxlayer", "tickets");
const DEFAULT_REPO = "EtanHey/cmuxlayer";
export const DELIVERY_TICKET_OCCURRENCE_CAP = 10;

export interface DeliveryFailureTicket {
  signature: string;
  delivery_id: string;
  agent_id: string;
  reason: string;
  cli?: string | null;
  what_happened: string;
  what_fixed_it: string;
  evidence: Record<string, unknown>;
  observed_at: string;
}

export interface DeliveryTicketRecord {
  signature: string;
  title: string;
  occurrence_count: number;
  occurrences: DeliveryFailureTicket[];
  github_issue_url?: string;
}

export function deliveryFailureSignature(input: {
  reason: string;
  cli?: string | null;
}): string {
  const normalized = `${input.cli ?? "unknown"}:${input.reason}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function defaultDeliveryTicketDir(): string {
  return DEFAULT_TICKET_DIR;
}

export function writeDeliveryFailureTicket(
  ticket: DeliveryFailureTicket,
  opts?: { dir?: string },
): { path: string; created: boolean; record: DeliveryTicketRecord } {
  const dir = opts?.dir ?? DEFAULT_TICKET_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ticket.signature}.json`);
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as DeliveryTicketRecord)
    : null;
  const record: DeliveryTicketRecord = existing
    ? {
        ...existing,
        occurrence_count: existing.occurrence_count + 1,
        occurrences: [...existing.occurrences, ticket].slice(
          -DELIVERY_TICKET_OCCURRENCE_CAP,
        ),
      }
    : {
        signature: ticket.signature,
        title: ticketTitle(ticket),
        occurrence_count: 1,
        occurrences: [ticket],
      };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { path, created: !existing, record };
}

export async function fileDeliveryFailureGithubIssue(
  ticket: DeliveryFailureTicket,
  opts?: {
    repo?: string;
    runner?: (
      file: string,
      args: string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  },
): Promise<string | null> {
  const repo = opts?.repo ?? DEFAULT_REPO;
  const run =
    opts?.runner ??
    (async (file, args) => execFileAsync(file, args, { timeout: 15_000 }));
  const marker = `cmuxlayer-delivery-failure:${ticket.signature}`;
  const title = ticketTitle(ticket);
  const body = [
    marker,
    "",
    ticket.what_happened,
    "",
    ticket.what_fixed_it,
    "",
    "```json",
    JSON.stringify(ticket.evidence, null, 2),
    "```",
  ].join("\n");
  try {
    const listed = await run("gh", [
      "issue",
      "list",
      "--repo",
      repo,
      "--search",
      marker,
      "--state",
      "all",
      "--json",
      "number,url,title",
    ]);
    const issues = JSON.parse(listed.stdout || "[]") as Array<{
      number: number;
      url: string;
    }>;
    if (issues[0]?.number) {
      await run("gh", [
        "issue",
        "comment",
        String(issues[0].number),
        "--repo",
        repo,
        "--body",
        body,
      ]);
      return issues[0].url ?? null;
    }
    const created = await run("gh", [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
    ]);
    return created.stdout.trim() || null;
  } catch {
    return null;
  }
}

function ticketTitle(ticket: DeliveryFailureTicket): string {
  return `delivery failure: ${ticket.reason} (${ticket.cli ?? "unknown"})`;
}
