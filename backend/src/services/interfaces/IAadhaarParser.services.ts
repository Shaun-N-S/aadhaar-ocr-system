import type { AadhaarParseResult } from "../../types/aadhaar.types";
import type { OcrResult } from "../../types/ocr.types";

/** Reads Aadhaar fields from the OCR results of the front and back images. */
export interface IAadhaarParser {
  parse(front: OcrResult, back: OcrResult): AadhaarParseResult;
}
