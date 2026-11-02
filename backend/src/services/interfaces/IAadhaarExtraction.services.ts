import type {
  AadhaarExtraction,
  AadhaarImageBuffers,
} from "../../types/aadhaar.types";
import type { OcrJobOptions } from "../../types/ocr.types";

export interface IAadhaarExtractionService {
  execute(
    images: AadhaarImageBuffers,
    options: OcrJobOptions,
  ): Promise<AadhaarExtraction>;
}
