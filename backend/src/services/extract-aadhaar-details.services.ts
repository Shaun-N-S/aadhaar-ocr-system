import type {
  AadhaarExtraction,
  AadhaarImageBuffers,
} from "../types/aadhaar.types";
import type { OcrJobOptions, OcrResult } from "../types/ocr.types";
import { IMAGE_FIELDS } from "../validators/upload.validator";
import type { IAadhaarExtractionService } from "./interfaces/IAadhaarExtraction.services";
import type { IAadhaarParser } from "./interfaces/IAadhaarParser.services";
import type { ITextRecognizer } from "./interfaces/IOcr.services";
import { OcrError } from "./ocr/ocr.errors";

export class NotAadhaarCardError extends Error {
  override name = "NotAadhaarCardError";
}

export class ExtractAadhaarDetailsService implements IAadhaarExtractionService {
  constructor(
    private readonly recognizer: ITextRecognizer,
    private readonly parser: IAadhaarParser,
  ) {}

  async execute(
    images: AadhaarImageBuffers,
    options: OcrJobOptions,
  ): Promise<AadhaarExtraction> {
    const [front, back] = await this.recognizeBothSides(images, options);

    const { documentDetected, details, confidence } = this.parser.parse(
      front,
      back,
    );
    if (!documentDetected) throw new NotAadhaarCardError();
    return { details, confidence };
  }

  private async recognizeBothSides(
    images: AadhaarImageBuffers,
    options: OcrJobOptions,
  ): Promise<[OcrResult, OcrResult]> {
    const results = await Promise.allSettled(
      IMAGE_FIELDS.map((field) =>
        this.recognizer.recognizeText(images[field], options),
      ),
    );

    const recognized: OcrResult[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const error: unknown = result.reason;
        throw error instanceof OcrError
          ? error.forSide(IMAGE_FIELDS[index]!)
          : error;
      }
      recognized.push(result.value);
    }

    return [recognized[0]!, recognized[1]!];
  }
}
