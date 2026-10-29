import type { ErrorRequestHandler } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS, type HttpStatus } from "../constants/http-status";
import { NotAadhaarCardError } from "../services/extract-aadhaar-details.services";
import { OcrError, type OcrErrorCode } from "../services/ocr/ocr.errors";
import { HttpError } from "../utils/http-error";

// The one place where domain errors get their HTTP status and message.
const OCR_ERROR_RESPONSES: Record<
  OcrErrorCode,
  { status: HttpStatus; message: (error: OcrError) => string }
> = {
  UNSUPPORTED_IMAGE: {
    status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    message: () => API_MESSAGES.UPLOAD.INVALID_FILE_TYPE,
  },
  IMAGE_UNREADABLE: {
    status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
    message: () => API_MESSAGES.OCR.IMAGE_UNREADABLE,
  },
  DIMENSIONS_TOO_LARGE: {
    status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
    message: ({ maxDimension }) =>
      `${API_MESSAGES.OCR.DIMENSIONS_TOO_LARGE} (${maxDimension} x ${maxDimension} px)`,
  },
  NO_TEXT: {
    status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
    message: () => API_MESSAGES.OCR.NO_TEXT_FOUND,
  },
  BUSY: {
    status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: () => API_MESSAGES.OCR.BUSY,
  },
  UNAVAILABLE: {
    status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: () => API_MESSAGES.OCR.UNAVAILABLE,
  },
  TIMEOUT: {
    status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: () => API_MESSAGES.OCR.TIMEOUT,
  },
};

/** The HTTP error a domain error is reported as, or null if it isn't one. */
export function toHttpError(error: unknown): HttpError | null {
  if (error instanceof OcrError) {
    const { status, message } = OCR_ERROR_RESPONSES[error.code];
    const text = message(error);
    return new HttpError(status, error.side ? `${error.side}: ${text}` : text, {
      cause: error,
    });
  }
  if (error instanceof NotAadhaarCardError) {
    return new HttpError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      API_MESSAGES.OCR.AADHAAR_NOT_DETECTED,
      { cause: error },
    );
  }
  return null;
}

// Runs before the generic error handler; anything else passes through.
export const translateDomainErrors: ErrorRequestHandler = (
  err,
  _req,
  _res,
  next,
) => {
  next(toHttpError(err) ?? err);
};
