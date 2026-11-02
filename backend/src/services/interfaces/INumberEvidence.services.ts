import type { OcrResult } from "../../types/ocr.types";

export interface INumberEvidence {
  hasAadhaarNumberEvidence(result: OcrResult): boolean;
  isNumberEvidenceLine(text: string): boolean;
}
