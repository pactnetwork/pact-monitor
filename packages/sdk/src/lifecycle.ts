/**
 * Process lifecycle.
 *
 * The durability guarantee lives in ObservationBuffer (synchronous append
 * before any network I/O), so a hard kill never loses data. This manager
 * adds graceful-exit niceties: a final best-effort reconciliation pass and
 * timer teardown on `beforeExit`/`SIGTERM`/`SIGINT`. Background timers are
 * already `unref()`ed by the poller/watcher, so the event loop exits on its
 * own — `shutdown()` is the optional "flush right now" escape hatch for
 * CLIs, serverless return paths, and tests.
 */
import type { IndexerPoller } from "./indexer-poller.js";
import type { AutoTopUpWatcher } from "./on-chain.js";

export interface LifecycleDeps {
  poller: IndexerPoller;
  autoTopUp?: AutoTopUpWatcher;
  installSignalHandlers: boolean;
}

export class LifecycleManager {
  private installed = false;
  private shuttingDown: Promise<void> | null = null;
  private readonly onSignal = () => {
    void this.shutdown();
  };
  private readonly onBeforeExit = () => {
    void this.shutdown();
  };

  constructor(private readonly deps: LifecycleDeps) {}

  install(): void {
    if (this.installed || !this.deps.installSignalHandlers) return;
    process.once("SIGTERM", this.onSignal);
    process.once("SIGINT", this.onSignal);
    process.once("beforeExit", this.onBeforeExit);
    this.installed = true;
  }

  private uninstall(): void {
    if (!this.installed) return;
    process.off("SIGTERM", this.onSignal);
    process.off("SIGINT", this.onSignal);
    process.off("beforeExit", this.onBeforeExit);
    this.installed = false;
  }

  /** Idempotent. Final reconcile pass, then stop all timers. */
  shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = (async () => {
      try {
        await this.deps.poller.flush();
      } catch {
        // best-effort; ObservationBuffer already persisted the data
      }
      this.deps.poller.stop();
      this.deps.autoTopUp?.stop();
      this.uninstall();
    })();
    return this.shuttingDown;
  }
}
