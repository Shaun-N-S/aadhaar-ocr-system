import type { OcrResult, RecognizeOptions } from "../../types/ocr.types";
import { readJpegOrientation } from "../../utils/image-header";
import type { INumberEvidence } from "../interfaces/INumberEvidence.services";
import { ImageDecodeError, OcrAbortedError, OcrError } from "./ocr.errors";
import type { EngineLease } from "./ocr-worker-pool";

class OcrTimeoutError extends Error {
  override name = "OcrTimeoutError";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OcrTimeoutError()), timeoutMs);
  });
  // If the timeout wins, the original promise may still reject later.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Clockwise rotation that makes an image with this EXIF orientation upright.
// Mirrored orientations (2, 4, 5, 7) are rare in photos and left untouched.
const EXIF_ROTATION: Partial<Record<number, number>> = {
  3: Math.PI,
  6: Math.PI / 2,
  8: -Math.PI / 2,
};

function applyExifOrientation(image: Buffer): {
  image: Buffer;
  rotation: number;
} {
  const orientation = readJpegOrientation(image);
  const rotation = orientation ? EXIF_ROTATION[orientation.value] : undefined;
  if (!orientation || rotation === undefined) return { image, rotation: 0 };

  const upright = Buffer.from(image);
  if (orientation.littleEndian) upright.writeUInt16LE(1, orientation.offset);
  else upright.writeUInt16BE(1, orientation.offset);
  return { image: upright, rotation };
}

// A pass is considered useful when it read a few words confidently. Sideways
// or upside-down text produces almost none, which triggers the retries below.
const CONFIDENT_WORD_SCORE = 80;
const MIN_CONFIDENT_WORDS = 4;
const RETRY_ROTATIONS = [Math.PI / 2, Math.PI, -Math.PI / 2];
// The number-recovery pass is skipped when less than this much of the
// image's time limit is left.
const MIN_RECOVERY_TIME_MS = 1000;

function countConfidentWords(result: OcrResult): number {
  return result.lines
    .flatMap((line) => line.words)
    .filter(
      (word) =>
        word.confidence >= CONFIDENT_WORD_SCORE &&
        /[A-Za-z0-9]{3,}/.test(word.text),
    ).length;
}

export interface RecognitionPipelineOptions {
  /** Per-image time limit shared by all passes, once a worker is free. */
  timeoutMs: number;
  /** Decides when the number-recovery pass runs and which lines it adds. */
  numberEvidence: INumberEvidence;
}

// The OCR passes for one image: EXIF orientation, a first pass, rotation
// retries when little text was read, and a number-recovery pass when no
// Aadhaar number was found.
export class RecognitionPipeline {
  constructor(private readonly options: RecognitionPipelineOptions) {}

  async recognize(
    lease: EngineLease,
    image: Buffer,
    signal: AbortSignal | undefined,
  ): Promise<OcrResult> {
    const { engine } = lease;
    const { timeoutMs, numberEvidence } = this.options;

    try {
      const deadline = Date.now() + timeoutMs;
      const upright = applyExifOrientation(image);
      const recognize = (
        extraRotation: number,
        options: RecognizeOptions = {},
      ) => {
        // A running pass is never interrupted; further passes are skipped
        // once the client has gone.
        if (signal?.aborted) throw new OcrAbortedError();
        return withTimeout(
          engine.recognize(upright.image, {
            ...options,
            rotateRadians: upright.rotation + extraRotation,
          }),
          Math.max(1, deadline - Date.now()),
        );
      };

      let result = await recognize(0);
      let resultRotation = 0;
      let bestScore = countConfidentWords(result);
      // Retry other orientations only when the first pass found little
      // usable text, stopping at the first one that does.
      for (const extraRotation of RETRY_ROTATIONS) {
        if (bestScore >= MIN_CONFIDENT_WORDS || Date.now() >= deadline) break;
        const attempt = await recognize(extraRotation);
        const score = countConfidentWords(attempt);
        if (score > bestScore) {
          result = attempt;
          resultRotation = extraRotation;
          bestScore = score;
        }
      }

      if (
        !numberEvidence.hasAadhaarNumberEvidence(result) &&
        Date.now() < deadline - MIN_RECOVERY_TIME_MS
      ) {
        try {
          const recovery = await recognize(resultRotation, {
            pageSegMode: "automatic",
          });
          const recovered = recovery.lines.filter((line) =>
            numberEvidence.isNumberEvidenceLine(line.text),
          );
          if (recovered.length > 0) {
            result = {
              ...result,
              text: [result.text, ...recovered.map((line) => line.text)].join(
                "\n",
              ),
              lines: [...result.lines, ...recovered],
            };
          }
        } catch (error) {
          if (error instanceof OcrAbortedError) throw error;

          lease.discard();
        }
      }

      const text = result.text.trim();
      if (!text) throw new OcrError("NO_TEXT");
      return {
        text,
        confidence: Math.round(result.confidence),
        lines: result.lines,
      };
    } catch (error) {
      if (error instanceof OcrError || error instanceof OcrAbortedError) {
        throw error;
      }
      if (error instanceof ImageDecodeError) {
        throw new OcrError("IMAGE_UNREADABLE", { cause: error });
      }

      lease.discard();
      if (error instanceof OcrTimeoutError) throw new OcrError("TIMEOUT");
      // Unexpected: becomes a logged 500 with a generic message.
      throw new Error("OCR recognition failed", { cause: error });
    }
  }
}
