import path from "node:path";
import { config } from "dotenv";
import { z } from "zod";

config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

// Used only outside production, so local development needs no .env.
const DEVELOPMENT_FRONTEND_URL = "http://localhost:5173";

// The frontend's Axios timeout (frontend/src/components/services/api-client.ts)
// is 120 s. Waiting for a worker plus OCR must finish well within it, leaving
// time for the upload and the response.
const MAX_SERVER_OCR_BUDGET_MS = 110_000;

// Browsers send just the origin ("https://ocr.example.com") and CORS compares
// it exactly, so a configured path or trailing slash is reduced to the origin.
const origin = z
  .url({ protocol: /^https?$/ })
  .transform((value) => new URL(value).origin);

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    // An empty value (common in hosting dashboards) counts as unset.
    FRONTEND_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      origin.optional(),
    ),
    MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().max(20).default(5),
    OCR_WORKER_COUNT: z.coerce.number().int().min(1).max(4).default(1),
    OCR_MAX_QUEUE: z.coerce.number().int().min(2).max(100).default(8),
    OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
    OCR_QUEUE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .default(60_000),
    OCR_MAX_IMAGE_DIMENSION: z.coerce.number().int().min(100).max(10_000).default(6000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.FRONTEND_URL) {
      context.addIssue({
        code: "custom",
        path: ["FRONTEND_URL"],
        message:
          "Required in production: the exact origin of the deployed frontend, e.g. https://ocr.example.com",
      });
    }
    if (value.OCR_QUEUE_TIMEOUT_MS < value.OCR_TIMEOUT_MS) {
      context.addIssue({
        code: "custom",
        path: ["OCR_QUEUE_TIMEOUT_MS"],
        message:
          "Must be at least OCR_TIMEOUT_MS, so a request's second image can wait while its first is processed",
      });
    }
    if (value.OCR_QUEUE_TIMEOUT_MS + value.OCR_TIMEOUT_MS > MAX_SERVER_OCR_BUDGET_MS) {
      context.addIssue({
        code: "custom",
        path: ["OCR_QUEUE_TIMEOUT_MS"],
        message: `OCR_QUEUE_TIMEOUT_MS + OCR_TIMEOUT_MS must be at most ${MAX_SERVER_OCR_BUDGET_MS} ms, so requests finish before the frontend's 120 s timeout`,
      });
    }
  })
  .transform((value) => ({
    ...value,
    FRONTEND_URL: value.FRONTEND_URL ?? DEVELOPMENT_FRONTEND_URL,
  }));

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Only report which variables failed and why; never print their values.
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
