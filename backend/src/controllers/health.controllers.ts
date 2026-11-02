import type { NextFunction, Request, Response } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import type { IOcrHealth } from "../services/interfaces/IOcr.services";

const NOT_READY_MESSAGES = {
  starting: API_MESSAGES.READINESS.STARTING,
  "language-data": API_MESSAGES.READINESS.LANGUAGE_DATA,
  unavailable: API_MESSAGES.READINESS.UNAVAILABLE,
  "shutting-down": API_MESSAGES.READINESS.SHUTTING_DOWN,
} as const;

export class HealthController {
  constructor(private readonly ocr: IOcrHealth) {}

  // Liveness: the HTTP server is up. Deliberately does no OCR work.
  health(_req: Request, res: Response, _next: NextFunction): void {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        status: API_MESSAGES.HEALTH.STATUS_OK,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // Readiness: an OCR engine has started successfully, so requests can be
  // served. Cheap: it reports the engine's state and never runs recognition.
  ready(_req: Request, res: Response, _next: NextFunction): void {
    res.set("Cache-Control", "no-store");
    const readiness = this.ocr.readiness();
    if (readiness.ready) {
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { status: API_MESSAGES.READINESS.READY },
      });
      return;
    }
    res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      success: false,
      error: { message: NOT_READY_MESSAGES[readiness.reason] },
    });
  }
}
