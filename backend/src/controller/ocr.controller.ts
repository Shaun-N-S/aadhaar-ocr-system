import type { RequestHandler } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import { parseAadhaar } from "../services/aadhaar-parser.service";
import { OcrAbortedError, ocrService } from "../services/ocr.service";
import type { OcrJobOptions, OcrResult } from "../types/ocr.types";
import { HttpError } from "../utils/http-error";
import {
  type AadhaarImages,
  IMAGE_FIELDS,
  validateAadhaarImages,
} from "../validators/upload.validator";

async function recognizeBothSides(
  images: AadhaarImages,
  jobOptions: OcrJobOptions,
): Promise<[OcrResult, OcrResult]> {
  const results = await Promise.allSettled(
    IMAGE_FIELDS.map((field) =>
      ocrService.recognizeText(images[field].buffer, jobOptions),
    ),
  );

  const recognized: OcrResult[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const error: unknown = result.reason;
      throw error instanceof HttpError
        ? new HttpError(
            error.status,
            `${IMAGE_FIELDS[index]}: ${error.message}`,
            { cause: error },
          )
        : error;
    }
    recognized.push(result.value);
  }

  return [recognized[0]!, recognized[1]!];
}

export const extractAadhaarDetails: RequestHandler = async (req, res) => {
  const images = validateAadhaarImages(req.files);

  // If the client disconnects, queued OCR for this request is dropped and
  // no further passes start (a pass already running is allowed to finish).
  const clientGone = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) clientGone.abort();
  });

  let front: OcrResult;
  let back: OcrResult;
  try {
    [front, back] = await recognizeBothSides(images, {
      reservation: res.locals.ocrReservation,
      signal: clientGone.signal,
    });
  } catch (error) {
    // Nobody is waiting for a response.
    if (error instanceof OcrAbortedError) return;
    throw error;
  }

  const { documentDetected, details, confidence } = parseAadhaar(front, back);
  if (!documentDetected) {
    throw new HttpError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      API_MESSAGES.OCR.AADHAAR_NOT_DETECTED,
    );
  }

  // Raw OCR text is deliberately not returned; only parsed, masked fields.
  res.status(HTTP_STATUS.OK).json({
    success: true,
    data: {
      message: API_MESSAGES.OCR.SUCCESS,
      aadhaar: details,
      // Mean recognition confidence of the words the fields were read from
      // (null if no field came from that image); not a probability.
      ocrConfidence: confidence,
    },
  });
};
