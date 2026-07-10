import { AsyncLocalStorage } from "node:async_hooks";

interface TransportRetryContext {
  retryCount: number;
}

const retryStorage = new AsyncLocalStorage<TransportRetryContext>();

export function withTransportRetryTracking<T>(fn: () => T): T {
  return retryStorage.run({ retryCount: 0 }, fn);
}

export function recordTransportRetry(): void {
  const context = retryStorage.getStore();
  if (context) context.retryCount += 1;
}

export function currentTransportRetryCount(): number {
  return retryStorage.getStore()?.retryCount ?? 0;
}
