import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import type { HealthController } from "./controllers/health.controllers";
import type { OcrController } from "./controllers/ocr.controllers";
import { translateDomainErrors } from "./middlewares/domain-error.middleware";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { HealthRoute } from "./routes/health.routes";
import { OcrRoute } from "./routes/ocr.routes";

/** What the Express application needs from the dependency container. */
export interface AppDependencies {
  frontendUrl: string;
  ocrController: OcrController;
  healthController: HealthController;
  reserveOcrCapacity: RequestHandler;
  uploadAadhaarImages: RequestHandler;
}

export class App {
  private app: Express;

  constructor(private container: AppDependencies) {
    this.app = express();
    this.setMiddleware();
    this.setRoutes();
    this.setErrorHandling();
  }

  private setMiddleware() {
    this.app.disable("x-powered-by");
    this.app.use(cors({ origin: this.container.frontendUrl }));
    this.app.use(express.json({ limit: "100kb" }));
  }

  private setRoutes() {
    const ocrRoute = new OcrRoute(
      this.container.ocrController,
      this.container.reserveOcrCapacity,
      this.container.uploadAadhaarImages,
    );
    const healthRoute = new HealthRoute(this.container.healthController);

    this.app.use("/api/ocr", ocrRoute.getRouter());
    this.app.use("/api", healthRoute.getRouter());
  }

  private setErrorHandling() {
    this.app.use(notFoundHandler);
    this.app.use(translateDomainErrors);
    this.app.use(errorHandler);
  }

  public getApp() {
    return this.app;
  }
}
