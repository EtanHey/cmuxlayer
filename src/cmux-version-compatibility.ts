export const TESTED_CMUX_APP_VERSIONS = ["0.64.17", "0.64.14-nightly"] as const;

export interface CmuxVersionCompatibilityReport {
  available: boolean;
  liveVersion: string | null;
  severity: "info" | "warn";
  tested: boolean | null;
  testedVersions: string[];
  note: string;
}

export interface CmuxVersionCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

export type CmuxVersionRunner = (
  env: NodeJS.ProcessEnv,
) => Promise<CmuxVersionCommandResult>;

function parseCmuxVersion(output: string): string | null {
  return output.match(/(?:^|\s)cmux\s+v?([^\s(]+)/i)?.[1] ?? null;
}

function isTestedVersion(version: string): boolean {
  return TESTED_CMUX_APP_VERSIONS.some(
    (tested) =>
      version === tested ||
      (tested.endsWith("-nightly") && version.startsWith(`${tested}.`)),
  );
}

export function assessCmuxVersionCompatibility(
  result: CmuxVersionCommandResult,
): CmuxVersionCompatibilityReport {
  const testedVersions = [...TESTED_CMUX_APP_VERSIONS];
  const testedLabel = testedVersions.map((version) => `v${version}`).join(", ");
  const liveVersion = result.ok
    ? parseCmuxVersion(`${result.stdout}\n${result.stderr}`)
    : null;

  if (!liveVersion) {
    return {
      available: false,
      liveVersion: null,
      severity: "info",
      tested: null,
      testedVersions,
      note: `running cmux version unavailable; tested against ${testedLabel}`,
    };
  }

  const tested = isTestedVersion(liveVersion);
  return {
    available: true,
    liveVersion,
    severity: tested ? "info" : "warn",
    tested,
    testedVersions,
    note: `running cmux v${liveVersion}; tested against ${testedLabel}${
      tested ? "" : " — behavior unverified"
    }`,
  };
}
