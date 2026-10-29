import type { ErrorRequestHandler, RequestHandler } from "express";
import { API_MESSAGES } from "../constants/api-messages";
import { HTTP_STATUS } from "../constants/http-status";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: { message: `${API_MESSAGES.SERVER.ROUTE_NOT_FOUND}: ${req.method} ${req.path}` },
  });
};

// Express 5 forwards rejected promises from async handlers here automatically,
// so route code can simply throw.
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Errors raised by Express/body-parser (e.g. malformed JSON) and our own
  // HttpError carry a `status`, plus `expose: true` when their message is safe
  // to return (Express sets it only for 4xx; HttpError always sets it).
  // The 400–599 bounds are the HTTP error-class range, not specific statuses.
  const status =
    typeof err?.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const isSafeToExpose = err?.expose === true;

  if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    // Log the error itself, never request bodies: they may contain personal data.
    console.error(err);
  }

  // Only messages explicitly marked safe are returned. Anything else gets a
  // generic message in every environment, so a missing NODE_ENV can't leak
  // internal details; developers see the full error in the server log.
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
