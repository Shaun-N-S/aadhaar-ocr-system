import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Worker as WorkerThread } from "node:worker_threads";
import {
  createWorker,
  OEM,
  PSM,
  type RecognizeOptions as TesseractRecognizeOptions,
  type WorkerParams,
} from "tesseract.js";
import { isProduction } from "../config/env";
import { API_MESSAGES } from "../constants/api-messages";
import type { OcrEngine } from "../types/ocr.types";

const TESSERACT_CACHE_DIR = path.resolve(__dirname, "../../.tesseract-cache");
const LANGUAGE_DATA = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../language-data.json"), "utf8"),
) as { file: string; sha256: string; size: number };

/** The build-time language data is missing or fails its checksum. */
export class LanguageDataError extends Error {
  override name = "LanguageDataError";
}

async function verifyLanguageData(): Promise<void> {
  const file = path.join(TESSERACT_CACHE_DIR, LANGUAGE_DATA.file);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new LanguageDataError(
      `${LANGUAGE_DATA.file} not found in ${TESSERACT_CACHE_DIR}; run "npm run fetch:lang-data"`,
    );
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (data.length !== LANGUAGE_DATA.size || sha256 !== LANGUAGE_DATA.sha256) {
    throw new LanguageDataError(
      `${LANGUAGE_DATA.file} does not match language-data.json; run "npm run fetch:lang-data"`,
    );
  }
}

const DECODE_FAILURE_MESSAGE = "Error attempting to read image";

export class ImageDecodeError extends Error {
  override name = "ImageDecodeError";
}

export async function createTesseractEngine(): Promise<OcrEngine> {
  if (isProduction) {
    await verifyLanguageData();
  } else {
    // Tesseract.js silently skips caching if the directory doesn't exist.
    await mkdir(TESSERACT_CACHE_DIR, { recursive: true });
  }

  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    cachePath: TESSERACT_CACHE_DIR,
    ...(isProduction && {
      cacheMethod: "readOnly",
      langPath: TESSERACT_CACHE_DIR,
      gzip: false,
    }),
    errorHandler: () => {},
  });

  let threadExited = false;
  const thread: unknown = Reflect.get(worker, "worker");
  if (thread instanceof WorkerThread) {
    thread.on("error", () => {
      threadExited = true;
    });
    thread.on("exit", () => {
      threadExited = true;
    });
  }

  return {
    async recognize(image, options = {}) {
      if (threadExited) {
        throw new Error("Tesseract worker thread has exited");
      }

      const callOptions: Partial<TesseractRecognizeOptions & WorkerParams> = {
        rotateRadians: options.rotateRadians ?? 0,
      };
      if (options.pageSegMode === "automatic") {
        callOptions.tessedit_pageseg_mode = PSM.AUTO;
      }

      try {
        const { data } = await worker.recognize(image, callOptions, {
          text: true,
          blocks: true,
        });
        const lines = (data.blocks ?? [])
          .flatMap((block) => block.paragraphs)
          .flatMap((paragraph) => paragraph.lines)
          .map((line) => ({
            text: line.text.trim(),
            confidence: Math.round(line.confidence),
            words: line.words
              .filter((word) => word.text.trim().length > 0)
              .map((word) => ({
                text: word.text.trim(),
                confidence: Math.round(word.confidence),
                bbox: {
                  x0: word.bbox.x0,
                  y0: word.bbox.y0,
                  x1: word.bbox.x1,
                  y1: word.bbox.y1,
                },
              })),
          }))
          .filter((line) => line.text.length > 0);

        return { text: data.text, confidence: data.confidence, lines };
      } catch (error) {
        // Tesseract.js rejects with plain strings, not Error objects.
        if (String(error).includes(DECODE_FAILURE_MESSAGE)) {
          throw new ImageDecodeError(API_MESSAGES.OCR.IMAGE_UNREADABLE);
        }
        throw error;
      }
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
