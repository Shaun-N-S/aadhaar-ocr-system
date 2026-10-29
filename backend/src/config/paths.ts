import path from "node:path";

// Files that live beside the code rather than in it. Resolved from this
// folder (src/config when run with tsx, dist/config when built), which sits
// two levels below the backend root in both cases.
const BACKEND_ROOT = path.resolve(__dirname, "../..");

/** OCR language model (model data only; images never touch the disk). */
export const TESSERACT_CACHE_DIR = path.join(BACKEND_ROOT, ".tesseract-cache");

/** Expected file name, size and SHA-256 of the language model. */
export const LANGUAGE_DATA_MANIFEST = path.join(BACKEND_ROOT, "language-data.json");
