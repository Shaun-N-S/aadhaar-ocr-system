import type { HttpStatus } from "../constants/http-status";

export class HttpError extends Error {
  readonly status: HttpStatus;
  readonly expose = true;

  constructor(status: HttpStatus, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
  }
}
