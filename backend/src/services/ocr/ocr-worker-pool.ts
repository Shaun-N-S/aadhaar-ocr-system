import type { OcrReadiness } from "../../types/ocr.types";
import type {
  IOcrEngine,
  IOcrEngineFactory,
} from "../interfaces/IOcrEngine.services";
import { LanguageDataError, OcrAbortedError, OcrError } from "./ocr.errors";

class QueueTimeoutError extends Error {
  override name = "QueueTimeoutError";
}

class ShutdownError extends Error {
  override name = "ShutdownError";
}

interface Waiter {
  resolve(slot: number): void;
  reject(error: Error): void;
}

type EngineStatus =
  | { state: "idle" | "starting" | "ready" }
  | { state: "failed"; at: number; languageData: boolean };

// A failed engine start is retried by a readiness check at most this often.
const READINESS_RETRY_MS = 30_000;

/** The engine a job may use, and a way to throw it away if it misbehaved. */
export interface EngineLease {
  readonly engine: IOcrEngine;
  discard(): void;
}

export interface OcrWorkerPoolOptions {
  /** Number of engines that may run recognition in parallel. */
  workerCount: number;
  /** Maximum time a job may wait for a free worker. */
  queueTimeoutMs: number;
  engineFactory: IOcrEngineFactory;
}

// A fixed set of worker slots, each lazily holding one engine. A job holds a
// slot for its whole run, so at most `workerCount` recognitions run at once;
// other jobs wait in order for a bounded time.
export class OcrWorkerPool {
  readonly #engines: (Promise<IOcrEngine> | undefined)[];
  readonly #freeSlots: number[];
  readonly #waiting: Waiter[] = [];
  readonly #queueTimeoutMs: number;
  readonly #engineFactory: IOcrEngineFactory;
  #status: EngineStatus = { state: "idle" };
  #closed = false;

  constructor({
    workerCount,
    queueTimeoutMs,
    engineFactory,
  }: OcrWorkerPoolOptions) {
    this.#engines = Array(workerCount).fill(undefined);
    this.#freeSlots = this.#engines.map((_engine, slot) => slot);
    this.#queueTimeoutMs = queueTimeoutMs;
    this.#engineFactory = engineFactory;
  }

  /**
   * Runs `work` with a worker's engine once a slot is free. The slot is
   * released only after `work` has settled, so a slot is never shared.
   */
  async run<T>(
    signal: AbortSignal | undefined,
    work: (lease: EngineLease) => Promise<T>,
  ): Promise<T> {
    let slot: number;
    try {
      slot = await this.#acquireSlot(signal);
    } catch (error) {
      if (error instanceof QueueTimeoutError) throw new OcrError("BUSY");
      if (error instanceof ShutdownError) throw new OcrError("UNAVAILABLE");
      throw error;
    }

    try {
      if (signal?.aborted) throw new OcrAbortedError();

      let engine: IOcrEngine;
      try {
        engine = await this.#getEngine(slot);
      } catch (error) {
        throw new OcrError("UNAVAILABLE", { cause: error });
      }

      return await work({ engine, discard: () => this.#discardEngine(slot) });
    } finally {
      this.#releaseSlot(slot);
    }
  }

  readiness(): OcrReadiness {
    if (this.#closed) return { ready: false, reason: "shutting-down" };
    const status = this.#status;
    if (status.state === "ready") return { ready: true };
    if (status.state === "starting")
      return { ready: false, reason: "starting" };
    if (
      status.state === "failed" &&
      Date.now() - status.at < READINESS_RETRY_MS
    ) {
      return {
        ready: false,
        reason: status.languageData ? "language-data" : "unavailable",
      };
    }

    this.#getEngine(0).catch(() => {});
    return { ready: false, reason: "starting" };
  }

  /** Starts an engine at startup so readiness reflects it without a request. */
  async warmUp(): Promise<OcrReadiness> {
    try {
      await this.#getEngine(0);
    } catch {
      // The failure is reflected in readiness().
    }
    return this.readiness();
  }

  /** Refuses further work: waiting jobs are rejected at once. */
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0))
      waiter.reject(new ShutdownError());
  }

  /** Terminates every engine. */
  async terminateAll(): Promise<void> {
    const running = [...this.#engines];
    this.#engines.fill(undefined);
    await Promise.allSettled(
      running.map((engine) => engine?.then((e) => e.terminate())),
    );
  }

  // Waits for a free slot for at most `queueTimeoutMs`. A waiter that times
  // out, is aborted, or is cancelled by shutdown leaves the queue, so it can
  // never be handed a slot afterwards.
  #acquireSlot(signal: AbortSignal | undefined): Promise<number> {
    const free = this.#freeSlots.pop();
    if (free !== undefined) return Promise.resolve(free);

    return new Promise((resolve, reject) => {
      const leave = (error: Error) => {
        const index = this.#waiting.indexOf(waiter);
        if (index === -1) return;
        this.#waiting.splice(index, 1);
        waiter.reject(error);
      };
      const timer = setTimeout(
        () => leave(new QueueTimeoutError()),
        this.#queueTimeoutMs,
      );
      const onAbort = () => leave(new OcrAbortedError());
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        resolve: (slot) => {
          cleanup();
          resolve(slot);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  #releaseSlot(slot: number): void {
    const nextJob = this.#waiting.shift();
    if (nextJob) nextJob.resolve(slot);
    else this.#freeSlots.push(slot);
  }

  #getEngine(slot: number): Promise<IOcrEngine> {
    const existing = this.#engines[slot];
    if (existing) return existing;

    const created = this.#engineFactory.create();
    this.#engines[slot] = created;
    if (this.#status.state !== "ready") this.#status = { state: "starting" };
    created.then(
      () => {
        this.#status = { state: "ready" };
      },
      (error: unknown) => {
        // Don't cache a failed start; the next job on this slot retries.
        if (this.#engines[slot] === created) this.#engines[slot] = undefined;
        this.#status = {
          state: "failed",
          at: Date.now(),
          languageData: error instanceof LanguageDataError,
        };
      },
    );
    return created;
  }

  // Throw away an engine that failed or hung; the slot gets a fresh one later.
  #discardEngine(slot: number): void {
    const engine = this.#engines[slot];
    this.#engines[slot] = undefined;
    engine?.then((e) => e.terminate()).catch(() => {});
  }
}
