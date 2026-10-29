import type { NextFunction, Request, Response } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import type { IAadhaarExtractionService } from "../services/interfaces/IAadhaarExtraction.services";
import { OcrAbortedError } from "../services/ocr/ocr.errors";
import type { AadhaarExtraction } from "../types/aadhaar.types";
import { validateAadhaarImages } from "../validators/upload.validator";

// HTTP only: reads the uploaded files, cancels the work if the client goes
// away, and maps the extraction result to the response body.
export class OcrController {
  constructor(private readonly extraction: IAadhaarExtractionService) {}

  async extract(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const images = validateAadhaarImages(req.files);

    const clientGone = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) clientGone.abort();
    });

    let result: AadhaarExtraction;
    try {
      result = await this.extraction.execute(
        {
          frontImage: images.frontImage.buffer,
          backImage: images.backImage.buffer,
        },
        {
          reservation: res.locals.ocrReservation,
          signal: clientGone.signal,
        },
      );
    } catch (error) {
      // Nobody is waiting for a response.
      if (error instanceof OcrAbortedError) return;
      throw error;
    }

    // Raw OCR text is deliberately not returned; only parsed, masked fields.
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        message: API_MESSAGES.OCR.SUCCESS,
        aadhaar: result.details,
        ocrConfidence: result.confidence,
      },
    });
  }
}
