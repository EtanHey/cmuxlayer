export const REPORT_NOTIFICATION_BODY_LIMIT = 3_500;
const REPORT_NOTIFICATION_HEADER_LIMIT = 20;
const REPORT_NOTIFICATION_LINE_LIMIT = 200;

export interface BoundedReportNotificationInput {
  firstLine: string;
  truncatedFirstLine: string;
  label: string;
  headers: string[];
  totalCount: number;
}

function boundedBullet(header: string): string {
  const maxHeaderLength = REPORT_NOTIFICATION_LINE_LIMIT - 2;
  const bounded =
    header.length <= maxHeaderLength
      ? header
      : `${header.slice(0, maxHeaderLength - 1)}…`;
  return `- ${bounded}`;
}

function render(
  firstLine: string,
  label: string,
  bullets: string[],
  omitted: number,
): string {
  return [
    firstLine,
    label,
    ...bullets,
    ...(omitted > 0 ? [`…and ${omitted} more`] : []),
  ].join("\n");
}

export function formatBoundedReportNotification(
  input: BoundedReportNotificationInput,
): string {
  const candidateHeaders = input.headers.slice(
    0,
    Math.min(input.totalCount, REPORT_NOTIFICATION_HEADER_LIMIT),
  );
  const minimumOmitted = input.totalCount > 0 ? input.totalCount : 0;
  const fullMinimum = render(
    input.firstLine,
    input.label,
    [],
    minimumOmitted,
  );
  const firstLine =
    fullMinimum.length <= REPORT_NOTIFICATION_BODY_LIMIT
      ? input.firstLine
      : input.truncatedFirstLine;
  const fallbackMinimum = render(
    firstLine,
    input.label,
    [],
    minimumOmitted,
  );
  if (fallbackMinimum.length > REPORT_NOTIFICATION_BODY_LIMIT) {
    const marker = "… (truncated)";
    return `${fallbackMinimum.slice(
      0,
      REPORT_NOTIFICATION_BODY_LIMIT - marker.length,
    )}${marker}`;
  }
  const bullets: string[] = [];
  for (const header of candidateHeaders) {
    const next = [...bullets, boundedBullet(header)];
    const candidate = render(
      firstLine,
      input.label,
      next,
      input.totalCount - next.length,
    );
    if (candidate.length > REPORT_NOTIFICATION_BODY_LIMIT) break;
    bullets.push(next.at(-1)!);
  }
  return render(
    firstLine,
    input.label,
    bullets,
    input.totalCount - bullets.length,
  );
}
