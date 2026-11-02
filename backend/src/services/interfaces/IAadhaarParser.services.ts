import type { AadhaarParseResult } from "../../types/aadhaar.types";
import type { OcrResult } from "../../types/ocr.types";

export interface IAadhaarParser {
  parse(front: OcrResult, back: OcrResult): AadhaarParseResult;
}
