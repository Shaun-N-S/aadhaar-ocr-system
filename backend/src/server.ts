import { env } from "./config/env";
import { container } from "./config/container";
import { App } from "./app";
import type { IOcrLifecycle } from "./services/interfaces/IOcr.services";

const app = new App(container).getApp();
const ocrService: IOcrLifecycle = container.ocrService;

const SHUTDOWN_GRACE_MS = env.OCR_TIMEOUT_MS + 5_000;

const server = app.listen(env.PORT, (error) => {
  if (error) {
    console.error(`Failed to start server on port ${env.PORT}:`, error.message);
    process.exit(1);
  }
  console.log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);

  void ocrService.warmUp().then((readiness) => {
    if (readiness.ready) console.log("OCR engine ready");
    else console.error(`OCR engine not ready: ${readiness.reason}`);
  });
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received, shutting down`);

  ocrService.beginShutdown();
  server.close(() => {
    void ocrService.shutdown().finally(() => process.exit(0));
  });
  setTimeout(() => {
    console.error("Shutdown grace period elapsed; exiting");
    void ocrService.shutdown().finally(() => process.exit(1));
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
