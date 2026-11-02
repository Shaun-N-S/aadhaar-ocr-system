export class OcrAbortedError extends Error {
  override name = "OcrAbortedError";
}

export class ImageDecodeError extends Error {
  override name = "ImageDecodeError";
}

export class LanguageDataError extends Error {
  override name = "LanguageDataError";
}

export type OcrErrorCode =
  | "UNSUPPORTED_IMAGE"
  | "IMAGE_UNREADABLE"
  | "DIMENSIONS_TOO_LARGE"
  | "NO_TEXT"
  | "BUSY"
  | "UNAVAILABLE"
  | "TIMEOUT";

export interface OcrErrorOptions extends ErrorOptions {
  side?: string;
  maxDimension?: number;
}

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

  forSide(side: string): OcrError {
    return new OcrError(this.code, {
      side,
      ...(this.maxDimension !== undefined && {
        maxDimension: this.maxDimension,
      }),
      cause: this,
    });
  }
}
