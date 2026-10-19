import { env } from "./config/env";
import app from "./app";
import { ocrService } from "./services/ocr.service";

// On shutdown, queued OCR jobs are refused at once, so in-flight requests
// need at most one image's OCR time (OCR_TIMEOUT_MS) to finish, plus a
// buffer. The hosting platform must allow at least this long between SIGTERM
// and a forced kill (e.g. Kubernetes terminationGracePeriodSeconds; Docker
// `stop --time`), or OCR_TIMEOUT_MS should be lowered to fit.
const SHUTDOWN_GRACE_MS = env.OCR_TIMEOUT_MS + 5_000;

const server = app.listen(env.PORT, (error) => {
  if (error) {
    console.error(`Failed to start server on port ${env.PORT}:`, error.message);
    process.exit(1);
  }
  console.log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);

  // Start an OCR engine in the background so /api/ready reflects it.
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

  // Refuse new and queued OCR work; jobs already running may finish.
  ocrService.beginShutdown();
  // Stop accepting connections; closes once in-flight responses are sent.
  server.close(() => {
    void ocrService.shutdown().finally(() => process.exit(0));
  });
  // Never hang: after the grace period, terminate the workers and exit.
  setTimeout(() => {
    console.error("Shutdown grace period elapsed; exiting");
    void ocrService.shutdown().finally(() => process.exit(1));
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
