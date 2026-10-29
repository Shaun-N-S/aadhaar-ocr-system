import express, { type RequestHandler } from "express";
import type { OcrController } from "../controllers/ocr.controllers";

export class OcrRoute {
  private router = express.Router();

  constructor(
    private controller: OcrController,
    private reserveOcrCapacity: RequestHandler,
    private uploadAadhaarImages: RequestHandler,
  ) {
    this.init();
  }

  private init() {
    // Capacity is reserved before the upload is buffered.
    this.router.post(
      "/",
      this.reserveOcrCapacity,
      this.uploadAadhaarImages,
      (req, res, next) => this.controller.extract(req, res, next),
    );
  }

  public getRouter() {
    return this.router;
  }
}
