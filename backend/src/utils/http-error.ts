import type { HttpStatus } from "../constants/http-status";

// Follows the `status` + `expose` convention used by Express's own errors, so
// the global error handler returns `message` to the client.
// Only pass messages that are safe to show to users; put internal details in
// `options.cause`, which is logged but never sent.
export class HttpError extends Error {
  readonly status: HttpStatus;
  readonly expose = true;

  constructor(status: HttpStatus, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
  }
}
