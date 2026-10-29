import { HealthController } from "../controllers/health.controllers";
import { OcrController } from "../controllers/ocr.controllers";
import { createReserveOcrCapacity } from "../middlewares/ocr-capacity.middleware";
import { createUploadAadhaarImages } from "../middlewares/upload.middleware";
import {
  hasAadhaarNumberEvidence,
  isNumberEvidenceLine,
} from "../services/aadhaar-parser.rules";
import { AadhaarParserService } from "../services/aadhaar-parser.services";
import { ExtractAadhaarDetailsService } from "../services/extract-aadhaar-details.services";
import { OcrCapacity } from "../services/ocr/ocr-capacity";
import { OcrService } from "../services/ocr/ocr.services";
import { OcrWorkerPool } from "../services/ocr/ocr-worker-pool";
import { RecognitionPipeline } from "../services/ocr/recognition-pipeline";
import {
  loadLanguageDataManifest,
  TesseractEngineFactory,
} from "../services/ocr/tesseract-engine";
import { env, isProduction } from "./env";
import { LANGUAGE_DATA_MANIFEST, TESSERACT_CACHE_DIR } from "./paths";

// The only place that chooses concrete implementations and wires them
// together; everything else receives its collaborators. Built once, when
// this module is first imported (after env has been validated).

const ocrEngineFactory = new TesseractEngineFactory({
  production: isProduction,
  cacheDir: TESSERACT_CACHE_DIR,
  languageData: loadLanguageDataManifest(LANGUAGE_DATA_MANIFEST),
});

const ocrService = new OcrService({
  capacity: new OcrCapacity(env.OCR_MAX_QUEUE),
  pool: new OcrWorkerPool({
    workerCount: env.OCR_WORKER_COUNT,
    queueTimeoutMs: env.OCR_QUEUE_TIMEOUT_MS,
    engineFactory: ocrEngineFactory,
  }),
  pipeline: new RecognitionPipeline({
    timeoutMs: env.OCR_TIMEOUT_MS,
    numberEvidence: { hasAadhaarNumberEvidence, isNumberEvidenceLine },
  }),
  maxImageDimension: env.OCR_MAX_IMAGE_DIMENSION,
});

const aadhaarParserService = new AadhaarParserService();

const extractAadhaarDetailsService = new ExtractAadhaarDetailsService(
  ocrService,
  aadhaarParserService,
);

const ocrController = new OcrController(extractAadhaarDetailsService);

const healthController = new HealthController(ocrService);

export const container = {
  frontendUrl: env.FRONTEND_URL,
  ocrController,
  healthController,
  reserveOcrCapacity: createReserveOcrCapacity(ocrService),
  uploadAadhaarImages: createUploadAadhaarImages({
    maxUploadSizeMb: env.MAX_UPLOAD_SIZE_MB,
  }),
  /** Used by the server process for warm-up, readiness and shutdown. */
  ocrService,
};
