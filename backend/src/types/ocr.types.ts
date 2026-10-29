import type { OcrReservation } from "../services/ocr/ocr-capacity";

export type ImageFormat = "jpeg" | "png";

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Pixel rectangle in the image as recognized (after any rotation). */
export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  /** Tesseract's confidence for this word, 0–100. Not a probability. */
  confidence: number;
  /** Null when no position is known (e.g. text without layout data). */
  bbox: BoundingBox | null;
}

export interface OcrLine {
  text: string;
  /** Tesseract's confidence for this line, 0–100. */
  confidence: number;
  /** The line's words with their positions, used for column-aware parsing. */
  words: OcrWord[];
}

export interface OcrResult {
  /** Full recognized text, trimmed. Internal only: never returned or logged. */
  text: string;
  /** Mean word confidence for the whole image, 0–100. */
  confidence: number;
  /** Non-empty lines in reading order, useful for field-level parsing. */
  lines: OcrLine[];
}

export interface RecognizeOptions {
  /** Rotate the image clockwise by this many radians before recognition. */
  rotateRadians?: number;
  /**
   * "automatic": Tesseract's automatic page layout analysis for this call
   * only, instead of the default single-block segmentation.
   */
  pageSegMode?: "automatic";
}

/** Queue capacity reserved for a request before its upload is read. */
export type { OcrReservation };

export interface OcrJobOptions {
  /** Capacity reserved earlier; the job uses it instead of joining the queue. */
  reservation?: OcrReservation;
  /** Aborted when the client has gone: queued work is dropped and further passes are skipped. */
  signal?: AbortSignal;
}

export type OcrReadiness =
  | { ready: true }
  | { ready: false; reason: "starting" | "language-data" | "unavailable" | "shutting-down" };
