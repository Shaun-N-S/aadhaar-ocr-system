import type { RequestHandler } from "express";
import { ocrService } from "../services/ocr.service";
import { IMAGE_FIELDS } from "../validators/upload.validator";

// Runs before the upload is read. Reserving OCR capacity for both images
// here means that, when the service is full, the request is refused with 503
// before its files are buffered into memory, and that at most
// OCR_MAX_QUEUE / 2 uploads can be held at once. The reservation is handed to
// the controller and released when the response closes, however it ends.
export const reserveOcrCapacity: RequestHandler = (_req, res, next) => {
  const reservation = ocrService.reserve(IMAGE_FIELDS.length);
  res.locals.ocrReservation = reservation;
  res.once("close", () => reservation.release());
  next();
};
