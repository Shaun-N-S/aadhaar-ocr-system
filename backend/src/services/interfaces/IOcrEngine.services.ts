import type { OcrResult, RecognizeOptions } from "../../types/ocr.types";

export interface IOcrEngine {
  recognize(image: Buffer, options?: RecognizeOptions): Promise<OcrResult>;
  terminate(): Promise<void>;
}

export interface IOcrEngineFactory {
  create(): Promise<IOcrEngine>;
}
