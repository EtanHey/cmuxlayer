import { AsyncLocalStorage } from "node:async_hooks";

interface TransportRetryContext {
  retryCount: number;
  cliFallbackUsed: boolean;
  cliFallbackSources: string[];
}

const retryStorage = new AsyncLocalStorage<TransportRetryContext>();

export function withTransportRetryTracking<T>(fn: () => T): T {
  return retryStorage.run(
    { retryCount: 0, cliFallbackUsed: false, cliFallbackSources: [] },
    fn,
  );
}

export function recordTransportRetry(): void {
  const context = retryStorage.getStore();
  if (context) context.retryCount += 1;
}

export function currentTransportRetryCount(): number {
  return retryStorage.getStore()?.retryCount ?? 0;
}

export function recordCliFallback(source = "unspecified"): void {
  const context = retryStorage.getStore();
  if (context) {
    context.cliFallbackUsed = true;
    if (!context.cliFallbackSources.includes(source)) {
      context.cliFallbackSources.push(source);
    }
  }
}

export function currentCliFallbackUsed(): boolean {
  return retryStorage.getStore()?.cliFallbackUsed ?? false;
}

export function currentCliFallbackSources(): string[] {
  return [...(retryStorage.getStore()?.cliFallbackSources ?? [])];
}
