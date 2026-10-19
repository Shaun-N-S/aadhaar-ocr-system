export const API_MESSAGES = {
  SERVER: {
    INTERNAL_ERROR: "Internal server error",
    REQUEST_FAILED: "Request failed",
    ROUTE_NOT_FOUND: "Route not found",
  },
  HEALTH: {
    STATUS_OK: "ok",
  },
  UPLOAD: {
    IMAGE_REQUIRED: "Required image missing",
    INVALID_FILE_TYPE: "Only JPEG and PNG images are allowed",
    CONTENT_MISMATCH: "File content does not match its declared image type",
    EMPTY_FILE: "Uploaded image is empty",
    IDENTICAL_IMAGES: "Front and back images must be different",
    FILE_TOO_LARGE: "Image exceeds the maximum allowed size",
    TOO_MANY_PARTS: "Too many files or fields in the upload",
    UNEXPECTED_FIELD: "Unexpected field",
    MALFORMED_REQUEST: "Malformed multipart/form-data request",
  },
  OCR: {
    SUCCESS: "Aadhaar details extracted successfully",
    PROCESSING_FAILED: "Could not process the image. Please try again",
    NO_TEXT_FOUND: "No readable text was found in the image",
    AADHAAR_NOT_DETECTED: "The image does not appear to be an Aadhaar card",
    IMAGE_UNREADABLE: "The image could not be decoded. It may be corrupt",
    DIMENSIONS_TOO_LARGE: "Image dimensions exceed the maximum allowed",
    BUSY: "OCR service is busy. Please try again shortly",
    TIMEOUT: "OCR took too long to complete. Please try again",
    UNAVAILABLE: "OCR service is temporarily unavailable",
  },
  READINESS: {
    READY: "ready",
    STARTING: "OCR engine is starting",
    LANGUAGE_DATA: "OCR language data is missing or invalid",
    UNAVAILABLE: "OCR engine could not start",
    SHUTTING_DOWN: "Server is shutting down",
  },
} as const;
