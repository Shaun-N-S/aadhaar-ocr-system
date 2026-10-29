import type { RequestHandler } from "express";
import multer from "multer";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import { HttpError } from "../utils/http-error";
import {
  hasAllowedTypeAndExtension,
  IMAGE_FIELDS,
} from "../validators/upload.validator";

const BYTES_PER_MB = 1024 * 1024;

export interface UploadLimits {
  maxUploadSizeMb: number;
}

function toHttpError(
  error: unknown,
  { maxUploadSizeMb }: UploadLimits,
): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof multer.MulterError) {
    const field = error.field ? `: ${error.field}` : "";

    switch (error.code) {
      case "LIMIT_FILE_SIZE":
        return new HttpError(
          HTTP_STATUS.PAYLOAD_TOO_LARGE,
          `${API_MESSAGES.UPLOAD.FILE_TOO_LARGE} (${maxUploadSizeMb} MB)${field}`,
        );
      case "LIMIT_UNEXPECTED_FILE":
      case "LIMIT_FIELD_COUNT":
        return new HttpError(
          HTTP_STATUS.BAD_REQUEST,
          `${API_MESSAGES.UPLOAD.UNEXPECTED_FIELD}${field}`,
        );
      case "LIMIT_FILE_COUNT":
      case "LIMIT_PART_COUNT":
        return new HttpError(
          HTTP_STATUS.BAD_REQUEST,
          API_MESSAGES.UPLOAD.TOO_MANY_PARTS,
        );
    }
  }

  // Anything else raised while parsing (e.g. busboy's "Unexpected end of
  // form") means the multipart body itself is invalid. Memory storage does no
  // I/O, so these are client errors rather than server faults.
  return new HttpError(
    HTTP_STATUS.BAD_REQUEST,
    API_MESSAGES.UPLOAD.MALFORMED_REQUEST,
  );
}

export function createUploadAadhaarImages(
  limits: UploadLimits,
): RequestHandler {
  // Memory storage: images exist only as Buffers on the request and are never
  // written to disk. The limits bound memory use to ~2 x the upload limit.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limits.maxUploadSizeMb * BYTES_PER_MB,
      files: IMAGE_FIELDS.length,
      fields: 0,
      parts: IMAGE_FIELDS.length,
    },
    fileFilter: (_req, file, callback) => {
      if (hasAllowedTypeAndExtension(file.mimetype, file.originalname)) {
        callback(null, true);
        return;
      }
      callback(
        new HttpError(
          HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
          `${file.fieldname}: ${API_MESSAGES.UPLOAD.INVALID_FILE_TYPE}`,
        ),
      );
    },
  }).fields(IMAGE_FIELDS.map((name) => ({ name, maxCount: 1 })));

  return (req, res, next) => {
    upload(req, res, (error?: unknown) => {
      next(error ? toHttpError(error, limits) : undefined);
    });
  };
}
