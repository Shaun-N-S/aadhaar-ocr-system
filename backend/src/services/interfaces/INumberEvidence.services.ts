import type { OcrResult } from "../../types/ocr.types";

/** Domain rules the OCR passes use to decide on the number-recovery pass. */
export interface INumberEvidence {
  /** The result already holds a checksum-valid, masked or VID number. */
  hasAadhaarNumberEvidence(result: OcrResult): boolean;
  /** This line holds such a number and is worth adding to the result. */
  isNumberEvidenceLine(text: string): boolean;
}
