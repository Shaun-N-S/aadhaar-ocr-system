import type { IMAGE_FIELDS } from "../validators/upload.validator";

export type Gender = "Male" | "Female" | "Transgender";

/**
 * Fields read from an Aadhaar card. Every field is null when it was not found
 * or was ambiguous; values are never guessed or filled with defaults.
 */
export interface AadhaarDetails {
  name: string | null;
  /** DD/MM/YYYY, only when printed as a full date of birth. */
  dateOfBirth: string | null;
  /** From the full date of birth, or from a printed "Year of Birth". */
  yearOfBirth: number | null;
  gender: Gender | null;
  /** Only the last four digits are revealed, e.g. "XXXX XXXX 1234". */
  maskedAadhaarNumber: string | null;
  address: string | null;
  pincode: string | null;
}

/**
 * Mean Tesseract word confidence (0–100) of the words the extracted fields
 * were read from, per image; null when no field came from that image. It
 * describes how clearly that text was recognized, not whether a field is
 * correct.
 */
export interface FieldTextConfidence {
  front: number | null;
  back: number | null;
}

export interface AadhaarParseResult {
  /** Whether the text looks like an Aadhaar card at all. */
  documentDetected: boolean;
  details: AadhaarDetails;
  confidence: FieldTextConfidence;
}

export type AadhaarImageBuffers = Record<(typeof IMAGE_FIELDS)[number], Buffer>;

export interface AadhaarExtraction {
  details: AadhaarDetails;
  confidence: FieldTextConfidence;
}
