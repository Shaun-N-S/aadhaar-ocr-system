import type {
  OcrJobOptions,
  OcrReadiness,
  OcrReservation,
  OcrResult,
} from "../../types/ocr.types";

// Role interfaces of the OCR service, one per kind of consumer, so each
// depends only on what it uses.

/** Runs OCR on one image (used by the extraction workflow). */
export interface ITextRecognizer {
  recognizeText(image: Buffer, options?: OcrJobOptions): Promise<OcrResult>;
}

/** Reserves capacity before an upload is read (used by middleware). */
export interface IOcrAdmission {
  reserve(jobs: number): OcrReservation;
}

/** Reports whether OCR can serve requests (used by /api/ready). */
export interface IOcrHealth {
  readiness(): OcrReadiness;
}

/** Starts and stops the OCR engines (used by the server process). */
export interface IOcrLifecycle {
  warmUp(): Promise<OcrReadiness>;
  beginShutdown(): void;
  shutdown(): Promise<void>;
}
