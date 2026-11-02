import path from "node:path";

const BACKEND_ROOT = path.resolve(__dirname, "../..");

export const TESSERACT_CACHE_DIR = path.join(BACKEND_ROOT, ".tesseract-cache");

export const LANGUAGE_DATA_MANIFEST = path.join(
  BACKEND_ROOT,
  "language-data.json",
);
