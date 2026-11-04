/**
 * Simple asynchronous mutex queue to serialize operations.
 * Used to ensure only one zcash-devtool process operates on the wallet directory at a time.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  public runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      return await fn();
    });

    // Keep the queue moving even if fn fails
    this.queue = next.then(
      () => {},
      () => {}
    );

    return next;
  }
}

export const zcashMutex = new AsyncMutex();

