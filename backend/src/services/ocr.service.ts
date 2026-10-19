import { env } from "../config/env";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import type {
  OcrEngine,
  OcrJobOptions,
  OcrReadiness,
  OcrReservation,
  OcrResult,
  OcrServiceOptions,
  RecognizeOptions,
} from "../types/ocr.types";
import {
  hasAadhaarNumberEvidence,
  isNumberEvidenceLine,
} from "./aadhaar-parser.service";
import {
  createTesseractEngine,
  ImageDecodeError,
  LanguageDataError,
} from "./tesseract-engine";
import { HttpError } from "../utils/http-error";
import {
  detectImageFormat,
  readImageDimensions,
  readJpegOrientation,
} from "../utils/image-header";

// Re-exported so callers that build their own service with createOcrService
// can keep importing everything from this module.
export { createTesseractEngine, LanguageDataError };

class OcrTimeoutError extends Error {
  override name = "OcrTimeoutError";
}

/** The client went away; the job was dropped before (more) work ran. */
export class OcrAbortedError extends Error {
  override name = "OcrAbortedError";
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OcrTimeoutError()), timeoutMs);
  });
  // If the timeout wins, the original promise may still reject later.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Clockwise rotation that makes an image with this EXIF orientation upright.
// Mirrored orientations (2, 4, 5, 7) are rare in photos and left untouched.
const EXIF_ROTATION: Partial<Record<number, number>> = {
  3: Math.PI,
  6: Math.PI / 2,
  8: -Math.PI / 2,
};

// Tesseract.js only honours big-endian EXIF orientation (it pattern-matches
// raw bytes), so orientation is applied here for both byte orders. The tag is
// reset to 1 in a copy so Tesseract.js cannot rotate the image a second time.
function applyExifOrientation(image: Buffer): { image: Buffer; rotation: number } {
  const orientation = readJpegOrientation(image);
  const rotation = orientation ? EXIF_ROTATION[orientation.value] : undefined;
  if (!orientation || rotation === undefined) return { image, rotation: 0 };

  const upright = Buffer.from(image);
  if (orientation.littleEndian) upright.writeUInt16LE(1, orientation.offset);
  else upright.writeUInt16BE(1, orientation.offset);
  return { image: upright, rotation };
}

// A pass is considered useful when it read a few words confidently. Sideways
// or upside-down text produces almost none, which triggers the retries below.
const CONFIDENT_WORD_SCORE = 80;
const MIN_CONFIDENT_WORDS = 4;
const RETRY_ROTATIONS = [Math.PI / 2, Math.PI, -Math.PI / 2];
// The number-recovery pass is skipped when less than this much of the
// image's time limit is left.
const MIN_RECOVERY_TIME_MS = 1000;

function countConfidentWords(result: OcrResult): number {
  return result.lines
    .flatMap((line) => line.words)
    .filter(
      (word) =>
        word.confidence >= CONFIDENT_WORD_SCORE &&
        /[A-Za-z0-9]{3,}/.test(word.text),
    ).length;
}

// Cheap checks on the raw bytes before any decoding happens. Matching magic
// bytes alone do not prove an image is safe to decode: a tiny compressed PNG
// can declare billions of pixels, so dimensions are read from the header.
function assertImageCanBeProcessed(image: Buffer, maxDimension: number): void {
  const format = detectImageFormat(image);
  if (!format) {
    throw new HttpError(
      HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
      API_MESSAGES.UPLOAD.INVALID_FILE_TYPE,
    );
  }

  const dimensions = readImageDimensions(image, format);
  if (!dimensions) {
    throw new HttpError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      API_MESSAGES.OCR.IMAGE_UNREADABLE,
    );
  }

  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    throw new HttpError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      `${API_MESSAGES.OCR.DIMENSIONS_TOO_LARGE} (${maxDimension} x ${maxDimension} px)`,
    );
  }
}

// A failed engine start is retried by a readiness check at most this often.
const READINESS_RETRY_MS = 30_000;

export function createOcrService(options: OcrServiceOptions) {
  const {
    workerCount,
    maxQueue,
    timeoutMs,
    queueTimeoutMs,
    maxImageDimension,
    createEngine,
  } = options;

  // A fixed pool of slots, each lazily holding one engine. A job holds a slot
  // for its whole run, so at most `workerCount` recognitions run at once.
  // `jobsInFlight` counts running, waiting and reserved jobs and never exceeds
  // `maxQueue`.
  const engines: (Promise<OcrEngine> | undefined)[] =
    Array(workerCount).fill(undefined);
  const freeSlots = engines.map((_engine, slot) => slot);
  const waitingJobs: Waiter[] = [];
  let jobsInFlight = 0;
  let isShutDown = false;
  let engineStatus: EngineStatus = { state: "idle" };

  // Capacity taken before a request's upload is read. Each job converts one
  // unit; release() hands back whatever no job used.
  class Reservation implements OcrReservation {
    #remaining: number;

    constructor(jobs: number) {
      this.#remaining = jobs;
    }

    take(): boolean {
      if (this.#remaining === 0) return false;
      this.#remaining -= 1;
      return true;
    }

    release(): void {
      jobsInFlight -= this.#remaining;
      this.#remaining = 0;
    }
  }

  /**
   * Reserves capacity for `jobs` images before an upload is buffered. The
   * check and the increment happen synchronously, so concurrent requests
   * can't all pass the check: at most `maxQueue` jobs are ever accepted.
   */
  function reserve(jobs: number): OcrReservation {
    if (isShutDown) {
      throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.OCR.UNAVAILABLE);
    }
    if (jobsInFlight + jobs > maxQueue) {
      throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.OCR.BUSY);
    }
    jobsInFlight += jobs;
    return new Reservation(jobs);
  }

  // Waits for a free slot for at most `queueTimeoutMs`. A waiter that times
  // out, is aborted, or is cancelled by shutdown leaves the queue, so it can
  // never be handed a slot afterwards.
  function acquireSlot(signal: AbortSignal | undefined): Promise<number> {
    const free = freeSlots.pop();
    if (free !== undefined) return Promise.resolve(free);

    return new Promise((resolve, reject) => {
      const leave = (error: Error) => {
        const index = waitingJobs.indexOf(waiter);
        if (index === -1) return;
        waitingJobs.splice(index, 1);
        waiter.reject(error);
      };
      const timer = setTimeout(() => leave(new QueueTimeoutError()), queueTimeoutMs);
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
      waitingJobs.push(waiter);
    });
  }

  function releaseSlot(slot: number): void {
    const nextJob = waitingJobs.shift();
    if (nextJob) nextJob.resolve(slot);
    else freeSlots.push(slot);
  }

  function getEngine(slot: number): Promise<OcrEngine> {
    const existing = engines[slot];
    if (existing) return existing;

    const created = createEngine();
    engines[slot] = created;
    if (engineStatus.state !== "ready") engineStatus = { state: "starting" };
    created.then(
      () => {
        engineStatus = { state: "ready" };
      },
      (error: unknown) => {
        // Don't cache a failed start; the next job on this slot retries.
        if (engines[slot] === created) engines[slot] = undefined;
        engineStatus = {
          state: "failed",
          at: Date.now(),
          languageData: error instanceof LanguageDataError,
        };
      },
    );
    return created;
  }

  // Throw away an engine that failed or hung; the slot gets a fresh one later.
  function discardEngine(slot: number): void {
    const engine = engines[slot];
    engines[slot] = undefined;
    engine?.then((e) => e.terminate()).catch(() => {});
  }

  async function recognizeText(
    image: Buffer,
    { reservation, signal }: OcrJobOptions = {},
  ): Promise<OcrResult> {
    // Join the queue by using one unit of reserved capacity. A call without a
    // reservation reserves a single unit for itself (same capacity check).
    const capacity = reservation ?? reserve(1);
    if (!(capacity instanceof Reservation) || !capacity.take()) {
      throw new Error("OCR reservation has no capacity left");
    }

    try {
      assertImageCanBeProcessed(image, maxImageDimension);
      if (isShutDown) {
        throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.OCR.UNAVAILABLE);
      }
      if (signal?.aborted) throw new OcrAbortedError();

      let slot: number;
      try {
        slot = await acquireSlot(signal);
      } catch (error) {
        if (error instanceof QueueTimeoutError) {
          throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.OCR.BUSY);
        }
        if (error instanceof ShutdownError) {
          throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE, API_MESSAGES.OCR.UNAVAILABLE);
        }
        throw error;
      }

      try {
        return await recognizeInSlot(slot, image, signal);
      } finally {
        // Only reached once this job's recognition has finished (or timed out
        // and its engine was discarded), so a slot is never shared.
        releaseSlot(slot);
      }
    } finally {
      jobsInFlight -= 1;
    }
  }

  async function recognizeInSlot(
    slot: number,
    image: Buffer,
    signal: AbortSignal | undefined,
  ): Promise<OcrResult> {
    // The client may have left while this job waited; skip the work.
    if (signal?.aborted) throw new OcrAbortedError();

    try {
      let engine: OcrEngine;
      try {
        engine = await getEngine(slot);
      } catch (error) {
        throw new HttpError(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          API_MESSAGES.OCR.UNAVAILABLE,
          { cause: error },
        );
      }

      // All passes for this image share one time limit, which starts once a
      // worker is free (waiting is bounded separately by queueTimeoutMs).
      const deadline = Date.now() + timeoutMs;
      const upright = applyExifOrientation(image);
      const recognize = (extraRotation: number, options: RecognizeOptions = {}) => {
        // A running pass is never interrupted; further passes are skipped
        // once the client has gone.
        if (signal?.aborted) throw new OcrAbortedError();
        return withTimeout(
          engine.recognize(upright.image, {
            ...options,
            rotateRadians: upright.rotation + extraRotation,
          }),
          Math.max(1, deadline - Date.now()),
        );
      };

      let result = await recognize(0);
      let resultRotation = 0;
      let bestScore = countConfidentWords(result);
      // Retry other orientations only when the first pass found little
      // usable text, stopping at the first one that does.
      for (const extraRotation of RETRY_ROTATIONS) {
        if (bestScore >= MIN_CONFIDENT_WORDS || Date.now() >= deadline) break;
        const attempt = await recognize(extraRotation);
        const score = countConfidentWords(attempt);
        if (score > bestScore) {
          result = attempt;
          resultRotation = extraRotation;
          bestScore = score;
        }
      }

      // Single-block segmentation often drops the large printed Aadhaar
      // number. If no number evidence was read, one extra pass with
      // automatic layout analysis looks for it; only its number/VID lines
      // are added, so all other lines and fields come from the pass above.
      // It runs in this slot and within the same deadline.
      if (
        !hasAadhaarNumberEvidence(result) &&
        Date.now() < deadline - MIN_RECOVERY_TIME_MS
      ) {
        try {
          const recovery = await recognize(resultRotation, {
            pageSegMode: "automatic",
          });
          const recovered = recovery.lines.filter((line) =>
            isNumberEvidenceLine(line.text),
          );
          if (recovered.length > 0) {
            result = {
              ...result,
              text: [result.text, ...recovered.map((line) => line.text)].join("\n"),
              lines: [...result.lines, ...recovered],
            };
          }
        } catch (error) {
          if (error instanceof OcrAbortedError) throw error;
          // Keep the original result. The worker may still be busy (timeout)
          // or keep the pass's settings, which Tesseract.js doesn't restore
          // after a failure, so it is replaced.
          discardEngine(slot);
        }
      }

      const text = result.text.trim();
      if (!text) {
        throw new HttpError(
          HTTP_STATUS.UNPROCESSABLE_ENTITY,
          API_MESSAGES.OCR.NO_TEXT_FOUND,
        );
      }
      return {
        text,
        confidence: Math.round(result.confidence),
        lines: result.lines,
      };
    } catch (error) {
      if (error instanceof HttpError || error instanceof OcrAbortedError) {
        throw error;
      }
      if (error instanceof ImageDecodeError) {
        throw new HttpError(HTTP_STATUS.UNPROCESSABLE_ENTITY, error.message);
      }

      discardEngine(slot);
      if (error instanceof OcrTimeoutError) {
        throw new HttpError(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          API_MESSAGES.OCR.TIMEOUT,
        );
      }
      // Unexpected: becomes a logged 500 with a generic message.
      throw new Error("OCR recognition failed", { cause: error });
    }
  }

  /**
   * Whether an OCR engine can start. Cheap: it never runs recognition. The
   * first call (and, after a failure, at most one call every 30 s) starts an
   * engine in the background and reports "starting" until it is ready.
   */
  function readiness(): OcrReadiness {
    if (isShutDown) return { ready: false, reason: "shutting-down" };
    const status = engineStatus;
    if (status.state === "ready") return { ready: true };
    if (status.state === "starting") return { ready: false, reason: "starting" };
    if (status.state === "failed" && Date.now() - status.at < READINESS_RETRY_MS) {
      return {
        ready: false,
        reason: status.languageData ? "language-data" : "unavailable",
      };
    }
    // Starting slot 0's engine doesn't occupy the slot; the next job there
    // reuses it.
    getEngine(0).catch(() => {});
    return { ready: false, reason: "starting" };
  }

  /** Starts an engine at startup so readiness reflects it without a request. */
  async function warmUp(): Promise<OcrReadiness> {
    try {
      await getEngine(0);
    } catch {
      // The failure is reflected in readiness().
    }
    return readiness();
  }

  /** Stops accepting work: new and queued jobs get 503; running jobs finish. */
  function beginShutdown(): void {
    isShutDown = true;
    for (const waiter of waitingJobs.splice(0)) waiter.reject(new ShutdownError());
  }

  /** Stops accepting work and terminates every engine. */
  async function shutdown(): Promise<void> {
    beginShutdown();
    const running = [...engines];
    engines.fill(undefined);
    await Promise.allSettled(
      running.map((engine) => engine?.then((e) => e.terminate())),
    );
  }

  return {
    reserve,
    recognizeText,
    readiness,
    warmUp,
    beginShutdown,
    shutdown,
  };
}

export const ocrService = createOcrService({
  workerCount: env.OCR_WORKER_COUNT,
  maxQueue: env.OCR_MAX_QUEUE,
  timeoutMs: env.OCR_TIMEOUT_MS,
  queueTimeoutMs: env.OCR_QUEUE_TIMEOUT_MS,
  maxImageDimension: env.OCR_MAX_IMAGE_DIMENSION,
  createEngine: createTesseractEngine,
});
