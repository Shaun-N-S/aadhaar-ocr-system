import type {
  OcrJobOptions,
  OcrReadiness,
  OcrResult,
} from "../../types/ocr.types";
import type {
  IOcrAdmission,
  IOcrHealth,
  IOcrLifecycle,
  ITextRecognizer,
} from "../interfaces/IOcr.services";
import {
  detectImageFormat,
  readImageDimensions,
} from "../../utils/image-header";
import type { OcrCapacity, OcrReservation } from "./ocr-capacity";
import { OcrAbortedError, OcrError } from "./ocr.errors";
import type { OcrWorkerPool } from "./ocr-worker-pool";
import type { RecognitionPipeline } from "./recognition-pipeline";


function assertImageCanBeProcessed(image: Buffer, maxDimension: number): void {
  const format = detectImageFormat(image);
  if (!format) throw new OcrError("UNSUPPORTED_IMAGE");

  const dimensions = readImageDimensions(image, format);
  if (!dimensions) throw new OcrError("IMAGE_UNREADABLE");

  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    throw new OcrError("DIMENSIONS_TOO_LARGE", { maxDimension });
  }
}

export interface OcrServiceDependencies {
  capacity: OcrCapacity;
  pool: OcrWorkerPool;
  pipeline: RecognitionPipeline;
  /** Maximum accepted width or height in pixels. */
  maxImageDimension: number;
}

export class OcrService
  implements ITextRecognizer, IOcrAdmission, IOcrHealth, IOcrLifecycle
{
  constructor(private readonly deps: OcrServiceDependencies) {}

  reserve(jobs: number): OcrReservation {
    return this.deps.capacity.reserve(jobs);
  }

  async recognizeText(
    image: Buffer,
    { reservation, signal }: OcrJobOptions = {},
  ): Promise<OcrResult> {
    const { capacity, pool, pipeline, maxImageDimension } = this.deps;
    capacity.startJob(reservation ?? capacity.reserve(1));

    try {
      assertImageCanBeProcessed(image, maxImageDimension);
      if (capacity.isClosed) throw new OcrError("UNAVAILABLE");
      if (signal?.aborted) throw new OcrAbortedError();

      return await pool.run(signal, (lease) =>
        pipeline.recognize(lease, image, signal),
      );
    } finally {
      capacity.finishJob();
    }
  }

  readiness(): OcrReadiness {
    return this.deps.pool.readiness();
  }

  warmUp(): Promise<OcrReadiness> {
    return this.deps.pool.warmUp();
  }

  /** Stops accepting work: new and queued jobs are refused; running jobs finish. */
  beginShutdown(): void {
    this.deps.capacity.close();
    this.deps.pool.close();
  }

  /** Stops accepting work and terminates every engine. */
  async shutdown(): Promise<void> {
    this.beginShutdown();
    await this.deps.pool.terminateAll();
  }
}
