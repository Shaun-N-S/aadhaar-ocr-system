import path from "node:path";
import type { Request } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import type { ImageFormat } from "../types/ocr.types";
import { HttpError } from "../utils/http-error";
import { detectImageFormat } from "../utils/image-header";

export const IMAGE_FIELDS = ["frontImage", "backImage"] as const;

type ImageField = (typeof IMAGE_FIELDS)[number];

export type AadhaarImages = Record<ImageField, Express.Multer.File>;

// Supported MIME types with their file extensions and actual content format.
const ALLOWED_IMAGE_TYPES: Record<
  string,
  { extensions: readonly string[]; format: ImageFormat }
> = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], format: "jpeg" },
  "image/png": { extensions: [".png"], format: "png" },
};

// Cheap pre-check on client-supplied metadata, run before the file is
// buffered. Both values are attacker-controlled, so content is checked later.
export function hasAllowedTypeAndExtension(
  mimeType: string,
  originalName: string,
): boolean {
  const type = ALLOWED_IMAGE_TYPES[mimeType];
  const extension = path.extname(originalName).toLowerCase();
  return type !== undefined && type.extensions.includes(extension);
}

function contentMatchesType(buffer: Buffer, mimeType: string): boolean {
  const type = ALLOWED_IMAGE_TYPES[mimeType];
  return type !== undefined && detectImageFormat(buffer) === type.format;
}

// Ensures exactly one front and one back image are present and that each
// file's bytes really are the image type it claims to be.
export function validateAadhaarImages(files: Request["files"]): AadhaarImages {
  const received = files && !Array.isArray(files) ? files : {};

  const missing = IMAGE_FIELDS.filter((field) => !received[field]?.[0]);
  if (missing.length > 0) {
    throw new HttpError(
      HTTP_STATUS.BAD_REQUEST,
      `${API_MESSAGES.UPLOAD.IMAGE_REQUIRED}: ${missing.join(", ")}`,
    );
  }

  const images = {
    frontImage: received.frontImage![0]!,
    backImage: received.backImage![0]!,
  };

  for (const field of IMAGE_FIELDS) {
    const { buffer, mimetype } = images[field];

    if (buffer.length === 0) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST,
        `${field}: ${API_MESSAGES.UPLOAD.EMPTY_FILE}`,
      );
    }
    if (!contentMatchesType(buffer, mimetype)) {
      throw new HttpError(
        HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
        `${field}: ${API_MESSAGES.UPLOAD.CONTENT_MISMATCH}`,
      );
    }
  }

  if (images.frontImage.buffer.equals(images.backImage.buffer)) {
    throw new HttpError(
      HTTP_STATUS.BAD_REQUEST,
      API_MESSAGES.UPLOAD.IDENTICAL_IMAGES,
    );
  }

  return images;
}
