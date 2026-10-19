import { Router } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";
import { ocrService } from "../services/ocr.service";
import ocrRoutes from "./ocr.routes";

const router = Router();

router.use("/ocr", ocrRoutes);

// Liveness: the HTTP server is up. Deliberately does no OCR work.
router.get("/health", (_req, res) => {
  res.status(HTTP_STATUS.OK).json({
    success: true,
    data: {
      status: API_MESSAGES.HEALTH.STATUS_OK,
      timestamp: new Date().toISOString(),
    },
  });
});

const NOT_READY_MESSAGES = {
  starting: API_MESSAGES.READINESS.STARTING,
  "language-data": API_MESSAGES.READINESS.LANGUAGE_DATA,
  unavailable: API_MESSAGES.READINESS.UNAVAILABLE,
  "shutting-down": API_MESSAGES.READINESS.SHUTTING_DOWN,
} as const;

// Readiness: an OCR engine has started successfully, so requests can be
// served. Cheap: it reports the engine's state and never runs recognition.
router.get("/ready", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const readiness = ocrService.readiness();
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
});

export default router;
