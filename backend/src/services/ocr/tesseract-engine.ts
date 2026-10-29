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
  type Worker,
  type WorkerParams,
} from "tesseract.js";
import type { OcrResult, RecognizeOptions } from "../../types/ocr.types";
import type {
  IOcrEngine,
  IOcrEngineFactory,
} from "../interfaces/IOcrEngine.services";
import { ImageDecodeError, LanguageDataError } from "./ocr.errors";

export interface LanguageDataManifest {
  file: string;
  sha256: string;
  size: number;
}

export function loadLanguageDataManifest(file: string): LanguageDataManifest {
  return JSON.parse(readFileSync(file, "utf8")) as LanguageDataManifest;
}

export interface TesseractEngineConfig {
  /** Production uses only the verified language data; nothing is downloaded. */
  production: boolean;
  cacheDir: string;
  languageData: LanguageDataManifest;
}

const DECODE_FAILURE_MESSAGE = "Error attempting to read image";

// Creates Tesseract workers. Production reads only the language data
// installed and verified at build time; development downloads it on first use.
export class TesseractEngineFactory implements IOcrEngineFactory {
  constructor(private readonly config: TesseractEngineConfig) {}

  async create(): Promise<IOcrEngine> {
    const { production, cacheDir } = this.config;
    if (production) {
      await this.verifyLanguageData();
    } else {
      // Tesseract.js silently skips caching if the directory doesn't exist.
      await mkdir(cacheDir, { recursive: true });
    }

    const worker = await createWorker("eng", OEM.LSTM_ONLY, {
      cachePath: cacheDir,
      ...(production && {
        cacheMethod: "readOnly",
        langPath: cacheDir,
        gzip: false,
      }),
      errorHandler: () => {},
    });
    return new TesseractOcrEngine(worker);
  }

  private async verifyLanguageData(): Promise<void> {
    const { cacheDir, languageData } = this.config;
    const file = path.join(cacheDir, languageData.file);
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new LanguageDataError(
        `${languageData.file} not found in ${cacheDir}; run "npm run fetch:lang-data"`,
      );
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.length !== languageData.size || sha256 !== languageData.sha256) {
      throw new LanguageDataError(
        `${languageData.file} does not match language-data.json; run "npm run fetch:lang-data"`,
      );
    }
  }
}

// One Tesseract worker behind the IOcrEngine contract.
export class TesseractOcrEngine implements IOcrEngine {
  #threadExited = false;

  constructor(private readonly worker: Worker) {
    const thread: unknown = Reflect.get(worker, "worker");
    if (thread instanceof WorkerThread) {
      thread.on("error", () => {
        this.#threadExited = true;
      });
      thread.on("exit", () => {
        this.#threadExited = true;
      });
    }
  }

  async recognize(
    image: Buffer,
    options: RecognizeOptions = {},
  ): Promise<OcrResult> {
    if (this.#threadExited) {
      throw new Error("Tesseract worker thread has exited");
    }

    const callOptions: Partial<TesseractRecognizeOptions & WorkerParams> = {
      rotateRadians: options.rotateRadians ?? 0,
    };
    if (options.pageSegMode === "automatic") {
      callOptions.tessedit_pageseg_mode = PSM.AUTO;
    }

    try {
      const { data } = await this.worker.recognize(image, callOptions, {
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
        throw new ImageDecodeError("Tesseract could not decode the image");
      }
      throw error;
    }
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}
