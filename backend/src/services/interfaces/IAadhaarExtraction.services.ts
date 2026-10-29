import type {
  AadhaarExtraction,
  AadhaarImageBuffers,
} from "../../types/aadhaar.types";
import type { OcrJobOptions } from "../../types/ocr.types";

/** The extraction workflow the OCR controller delegates to. */
export interface IAadhaarExtractionService {
  execute(
    images: AadhaarImageBuffers,
    options: OcrJobOptions,
  ): Promise<AadhaarExtraction>;
}
