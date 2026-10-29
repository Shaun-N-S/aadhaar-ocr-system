// Errors shared by the OCR engine contract and its callers. Each class is
// defined only here, so `instanceof` checks hold across modules.

/** The client went away; the job was dropped before (more) work ran. */
export class OcrAbortedError extends Error {
  override name = "OcrAbortedError";
}

/** The image bytes could not be decoded; the engine itself is still healthy. */
export class ImageDecodeError extends Error {
  override name = "ImageDecodeError";
}

/** The build-time language data is missing or fails its checksum. */
export class LanguageDataError extends Error {
  override name = "LanguageDataError";
}

/** Why OCR could not produce a result. Mapped to HTTP at the boundary. */
export type OcrErrorCode =
  | "UNSUPPORTED_IMAGE"
  | "IMAGE_UNREADABLE"
  | "DIMENSIONS_TOO_LARGE"
  | "NO_TEXT"
  | "BUSY"
  | "UNAVAILABLE"
  | "TIMEOUT";

export interface OcrErrorOptions extends ErrorOptions {
  /** The image field the error belongs to, e.g. "frontImage". */
  side?: string;
  /** The limit that was exceeded, for DIMENSIONS_TOO_LARGE. */
  maxDimension?: number;
}

/** An expected OCR failure, described without any HTTP details. */
export class OcrError extends Error {
  override name = "OcrError";
  readonly side: string | undefined;
  readonly maxDimension: number | undefined;

  constructor(
    readonly code: OcrErrorCode,
    { side, maxDimension, ...options }: OcrErrorOptions = {},
  ) {
    super(code, options);
    this.side = side;
    this.maxDimension = maxDimension;
  }

  /** The same error, attributed to one of the uploaded images. */
  forSide(side: string): OcrError {
    return new OcrError(this.code, {
      side,
      ...(this.maxDimension !== undefined && { maxDimension: this.maxDimension }),
      cause: this,
    });
  }
}
