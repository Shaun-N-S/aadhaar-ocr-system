import express from "express";
import type { HealthController } from "../controllers/health.controllers";

export class HealthRoute {
  private router = express.Router();

  constructor(private controller: HealthController) {
    this.init();
  }

  private init() {
    this.router.get("/health", (req, res, next) =>
      this.controller.health(req, res, next),
    );
    this.router.get("/ready", (req, res, next) =>
      this.controller.ready(req, res, next),
    );
  }

  public getRouter() {
    return this.router;
  }
}
