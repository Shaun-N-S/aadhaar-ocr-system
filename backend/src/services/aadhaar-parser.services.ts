import type { AadhaarParseResult } from "../types/aadhaar.types";
import type { OcrResult } from "../types/ocr.types";
import { parseAadhaar } from "./aadhaar-parser.rules";
import type { IAadhaarParser } from "./interfaces/IAadhaarParser.services";

// The parser behind its interface; the parsing rules themselves stay pure
// functions in aadhaar-parser.rules.ts.
export class AadhaarParserService implements IAadhaarParser {
  parse(front: OcrResult, back: OcrResult): AadhaarParseResult {
    return parseAadhaar(front, back);
  }
}
