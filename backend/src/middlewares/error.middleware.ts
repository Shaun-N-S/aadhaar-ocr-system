import type { ErrorRequestHandler, RequestHandler } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: { message: `${API_MESSAGES.SERVER.ROUTE_NOT_FOUND}: ${req.method} ${req.path}` },
  });
};


export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status =
    typeof err?.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const isSafeToExpose = err?.expose === true;

  if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    console.error(err);
  }

  const genericMessage =
    status >= HTTP_STATUS.INTERNAL_SERVER_ERROR
      ? API_MESSAGES.SERVER.INTERNAL_ERROR
      : API_MESSAGES.SERVER.REQUEST_FAILED;
  res.status(status).json({
    success: false,
    error: {
      message: isSafeToExpose
        ? String(err?.message ?? genericMessage)
        : genericMessage,
    },
  });
};
