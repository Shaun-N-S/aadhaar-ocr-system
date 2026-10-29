import type { OcrResult, RecognizeOptions } from "../../types/ocr.types";

/** The OCR backend the service drives; Tesseract in production, a fake in tests. */
export interface IOcrEngine {
  recognize(image: Buffer, options?: RecognizeOptions): Promise<OcrResult>;
  terminate(): Promise<void>;
}

/** Starts a new engine; the service calls it lazily, once per worker slot. */
export interface IOcrEngineFactory {
  create(): Promise<IOcrEngine>;
}
