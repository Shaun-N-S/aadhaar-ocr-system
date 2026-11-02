import type {
  OcrJobOptions,
  OcrReadiness,
  OcrReservation,
  OcrResult,
} from "../../types/ocr.types";

export interface ITextRecognizer {
  recognizeText(image: Buffer, options?: OcrJobOptions): Promise<OcrResult>;
}

export interface IOcrAdmission {
  reserve(jobs: number): OcrReservation;
}

export interface IOcrHealth {
  readiness(): OcrReadiness;
}

export interface IOcrLifecycle {
  warmUp(): Promise<OcrReadiness>;
  beginShutdown(): void;
  shutdown(): Promise<void>;
}
