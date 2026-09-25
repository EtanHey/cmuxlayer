/** Resolve after `ms` milliseconds. The one sleep; inject it where tests need control. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
