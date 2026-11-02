import type {
  AadhaarDetails,
  AadhaarParseResult,
  Gender,
} from "../types/aadhaar.types";
import type { OcrLine, OcrResult, OcrWord } from "../types/ocr.types";
import { isValidVerhoeff } from "../utils/verhoeff";

const DOB_KEYWORD = /\bD[O0]B\b|DATE\s+OF\s+BIRTH/i;
const YOB_KEYWORD = /\bY[O0]B\b|YEAR\s+OF\s+BIRTH/i;
const ADDRESS_KEYWORD = /\bAdd?ress?\b\s*[:;-]?/i;
const ADDRESS_LABEL_WORD = /^[^\p{L}\p{N}]{0,2}Add?ress?\b\s*[:;-]?/iu;
const GENDER_WORD = /\b(FEMALE|MALE|TRANSGENDER)\b/i;
const MASKED_NUMBER = /(?<![\w*])[Xx*]{4}\s?[Xx*]{4}\s?\d{4}(?!\d)/;

const UIDAI_PHRASES = [["UNIQUE", "IDENTIFICATION", "AUTHORITY"], ["UIDAI"]];
const GOVERNMENT_PHRASES = [["GOVERNMENT", "OF", "INDIA"]];
const VID_PHRASES = [["VID"], ["VIRTUAL", "ID"]];
const LONG_WORD = 6;
const MAX_PHRASE_EDITS = 2;

function canonicalWord(word: string): string {
  return word
    .toUpperCase()
    .replace(/RN/g, "M")
    .replace(/[L1|!]/g, "I")
    .replace(/0/g, "O");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_value, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

function containsPhrase(text: string, phrases: string[][]): boolean {
  const tokens = text
    .normalize("NFKC")
    .split(/[^A-Za-z0-9|!]+/)
    .filter(Boolean)
    .map(canonicalWord);
  return phrases.some((phrase) => {
    const words = phrase.map(canonicalWord);
    for (let start = 0; start + words.length <= tokens.length; start++) {
      let edits = 0;
      const matches = words.every((word, offset) => {
        const distance = editDistance(tokens[start + offset]!, word);
        edits += distance;
        return distance <= (word.length >= LONG_WORD ? 1 : 0);
      });
      if (matches && edits <= MAX_PHRASE_EDITS) return true;
    }
    return false;
  });
}

const hasUidaiBranding = (text: string) => containsPhrase(text, UIDAI_PHRASES);

const hasGovernmentHeader = (text: string) =>
  containsPhrase(text, GOVERNMENT_PHRASES);
const hasVidLabel = (text: string) => containsPhrase(text, VID_PHRASES);

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  o: "0",
  I: "1",
  l: "1",
  "|": "1",
  S: "5",
  B: "8",
};

const DIGIT_GROUP_RUN =
  /(?<![\w|])[\dOoIlSB|]{4}(?:[ -]?[\dOoIlSB|]{4})+(?![\w|])/g;
const VID_NUMBER = /\d{4}\s?\d{4}\s?\d{4}\s?\d{4}/;
const DATE =
  /(?<![\dOoIl])([\dOoIl]{1,2})\s?[/.-]\s?([\dOoIl]{1,2})\s?[/.-]\s?([\dOoIl]{4})(?![\dOoIl])/;

const SLASH_LABEL_BEFORE_DATE = /\/\s*[A-Za-z0-9]{2,4}\s*[:.;,]\s*$/;

const DOB_LABEL_AT_END = /(?:\bD[O0]B|DATE\s+OF\s+BIRTH)\s*:?\s*$/i;
// Dates that are not a date of birth.
const OTHER_DATE_LABELS =
  /ISSUE|DOWNLOAD|PRINT|GENERAT|VALID|EXPIR|ENROL|UPDATE/i;
const YEAR = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
const PINCODE = /(?<!\d)([1-9]\d{5})(?!\d)/g;
const HAS_PINCODE = /(?<!\d)[1-9]\d{5}(?!\d)/;

const NON_NAME_WORDS =
  /GOVERNMENT|INDIA|AADHAA?R|UNIQUE|IDENTIFICATION|AUTHORITY|\bD[O0]B\b|BIRTH|\bY[O0]B\b|FEMALE|\bMALE\b|TRANSGENDER|ADDRESS|\bVID\b|ENROL|PROOF|IDENTITY|CITIZEN|VERIF|AUTHENTICAT|\bQR\b|ISSUE|DOWNLOAD|FATHER|MOTHER|HUSBAND|GUARDIAN|\b[SDWC]\s?\/\s?O\b|^\s*To\b/i;
const MIN_NAME_CONFIDENCE = 60;

const NAME_MAX_LINE_GAP = 3;
const MAX_ADDRESS_LINES = 6;

const ADDRESS_STOP =
  /\bVID\b|UIDAI|www\.|@|AADHAA?R|\d{4}\s?\d{4}\s?\d{4}|[Xx*]{4}\s?[Xx*]{4}\s?\d{4}/i;
const ADDRESS_LEFT_TOLERANCE = 1.5;
const ADDRESS_MAX_LINE_GAP = 2.5;
const ADDRESS_MAX_WORD_GAP = 3;

const ADDRESS_GAP_TO_SPACE_RATIO = 4;

interface Candidate<T> {
  value: T;
  words: OcrWord[];
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function linesOf(result: OcrResult): OcrLine[] {
  const lines =
    result.lines.length > 0
      ? result.lines
      : result.text.split("\n").map((text) => ({
          text,
          confidence: result.confidence,
          words: [],
        }));
  return lines
    .map((line) => {
      const text = normalizeWhitespace(line.text);
      // Text without layout data: words without positions.
      const words =
        line.words.length > 0
          ? line.words
          : text
              .split(" ")
              .filter(Boolean)
              .map((word) => ({
                text: word,
                confidence: line.confidence,
                bbox: null,
              }));
      return { ...line, text, words };
    })
    .filter((line) => line.text.length > 0);
}

/** The words of `line` that make up `fragment`. */
function wordsIn(line: OcrLine, fragment: string): OcrWord[] {
  return line.words.filter((word) => fragment.includes(word.text));
}

function replaceLookalikes(text: string): string {
  return [...text].map((char) => DIGIT_LOOKALIKES[char] ?? char).join("");
}

// --- Aadhaar number -------------------------------------------------------

function findAadhaarNumbers(lines: OcrLine[]): Candidate<string>[] {
  const numbers: Candidate<string>[] = [];

  for (const line of lines) {
    if (hasVidLabel(line.text)) continue;

    for (const [run] of line.text.matchAll(DIGIT_GROUP_RUN)) {
      const raw = run.replace(/[ -]/g, "");
      if (raw.length !== 12) continue;

      const groups = raw.match(/.{4}/g) ?? [];
      if (!groups.every((group) => (group.match(/\d/g) ?? []).length >= 3)) {
        continue;
      }

      const digits = replaceLookalikes(raw);
      if (/^[2-9]/.test(digits) && isValidVerhoeff(digits)) {
        numbers.push({ value: digits, words: wordsIn(line, run) });
      }
    }
  }
  return numbers;
}

function maskAadhaarNumber(digits: string): string {
  return `XXXX XXXX ${digits.slice(-4)}`;
}

function hasVid(lines: OcrLine[]): boolean {
  return lines.some(({ text }) => hasVidLabel(text) && VID_NUMBER.test(text));
}

const NUMBER_EVIDENCE_RUN =
  /(?<![\w|])[\dOoIlSB|]{4}(?:[ -]?[\dOoIlSB|]{4}){2,}(?![\w|])/;

export function hasAadhaarNumberEvidence(result: OcrResult): boolean {
  return (
    findAadhaarNumbers(linesOf(result)).length > 0 ||
    MASKED_NUMBER.test(result.text.normalize("NFKC"))
  );
}

export function isNumberEvidenceLine(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return (
    NUMBER_EVIDENCE_RUN.test(normalized) ||
    MASKED_NUMBER.test(normalized) ||
    hasVidLabel(normalized)
  );
}

// --- Date / year of birth --------------------------------------------------

function toValidDate(day: number, month: number, year: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!isRealDate || year < 1900 || date.getTime() > Date.now()) return null;

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(day)}/${pad(month)}/${year}`;
}

function matchDateOfBirth(text: string): RegExpMatchArray | null {
  if (OTHER_DATE_LABELS.test(text)) return null;
  const match = text.match(DATE);
  if (!match) return null;
  const labelled =
    DOB_KEYWORD.test(text) ||
    SLASH_LABEL_BEFORE_DATE.test(text.slice(0, match.index));
  return labelled ? match : null;
}

function matchWrappedDateOfBirth(
  labelText: string,
  dateText: string,
): RegExpMatchArray | null {
  if (!DOB_LABEL_AT_END.test(labelText) || DATE.test(labelText)) return null;
  if (OTHER_DATE_LABELS.test(labelText)) return null;
  const match = dateText.match(DATE);
  const rest = match
    ? dateText.replace(match[0], "").replace(/[\s:.,;|]/g, "")
    : "x";
  return match && rest === "" ? match : null;
}

function dobMatchAt(lines: OcrLine[], index: number): RegExpMatchArray | null {
  const text = lines[index]!.text;
  return (
    matchDateOfBirth(text) ??
    (index > 0 ? matchWrappedDateOfBirth(lines[index - 1]!.text, text) : null)
  );
}

function findDatesOfBirth(lines: OcrLine[]): Candidate<string>[] {
  const dates: Candidate<string>[] = [];
  for (const [index, line] of lines.entries()) {
    const match = dobMatchAt(lines, index);
    if (!match) continue;
    const [day, month, year] = match
      .slice(1, 4)
      .map((part) => Number(replaceLookalikes(part!)));
    const date = toValidDate(day!, month!, year!);
    if (date) dates.push({ value: date, words: wordsIn(line, match[0]) });
  }
  return dates;
}

function findBirthYears(lines: OcrLine[]): Candidate<number>[] {
  const years: Candidate<number>[] = [];
  for (const line of lines) {
    if (!YOB_KEYWORD.test(line.text)) continue;
    const match = line.text.match(YEAR);
    const year = Number(match?.[1]);
    if (match && year >= 1900 && year <= new Date().getFullYear()) {
      years.push({ value: year, words: wordsIn(line, match[1]!) });
    }
  }
  return years;
}

// --- Gender ----------------------------------------------------------------

const GENDERS: Record<string, Gender> = {
  FEMALE: "Female",
  MALE: "Male",
  TRANSGENDER: "Transgender",
};

function findGenders(lines: OcrLine[]): Candidate<Gender>[] {
  const genders: Candidate<Gender>[] = [];
  for (const line of lines) {
    const match = line.text.match(GENDER_WORD);
    if (match) {
      genders.push({
        value: GENDERS[match[1]!.toUpperCase()]!,
        words: wordsIn(line, match[1]!),
      });
    }
  }
  return genders;
}

// --- Name ------------------------------------------------------------------

function isEdgeNoise(word: OcrWord, neighbour: OcrWord | undefined): boolean {
  if (!/[A-Za-z]/.test(word.text) || /^[a-z]$/.test(word.text)) return true;
  if (word.text.length !== 1 || !word.bbox || !neighbour?.bbox) return false;
  const height = word.bbox.y1 - word.bbox.y0;
  const gap = Math.max(
    neighbour.bbox.x0 - word.bbox.x1,
    word.bbox.x0 - neighbour.bbox.x1,
  );
  return gap > height * 1.5;
}

// A line that could be the cardholder's name, with the words it came from.
function asName(line: OcrLine): Candidate<string> | null {
  if (NON_NAME_WORDS.test(line.text)) return null;

  const words = [...line.words];
  if (words[0] && /^name[:;-]?$/i.test(words[0].text)) words.shift();
  while (words.length > 0 && isEdgeNoise(words[0]!, words[1])) words.shift();
  while (words.length > 0 && isEdgeNoise(words.at(-1)!, words.at(-2))) {
    words.pop();
  }

  const candidate = normalizeWhitespace(
    words.map((word) => word.text).join(" "),
  ).replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "");
  const parts = candidate.split(" ");
  const looksLikeName =
    /^[A-Za-z][A-Za-z.' ]*[A-Za-z.]$/.test(candidate) &&
    candidate.length <= 60 &&
    parts.length <= 5 &&
    parts.some((part) => /^[A-Za-z]{3,}/.test(part)) &&
    parts.every((part) => /^[A-Z]/.test(part));
  if (!looksLikeName) return null;

  const confidence =
    words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
  return confidence >= MIN_NAME_CONFIDENCE ? { value: candidate, words } : null;
}

function verticalExtent(
  words: OcrWord[],
): { top: number; bottom: number } | null {
  const boxes = words.map((word) => word.bbox).filter((box) => box !== null);
  if (boxes.length === 0) return null;
  return {
    top: Math.min(...boxes.map((box) => box.y0)),
    bottom: Math.max(...boxes.map((box) => box.y1)),
  };
}

function findNames(lines: OcrLine[]): Candidate<string>[] {
  const anchors = [
    lines.findIndex((_line, index) => dobMatchAt(lines, index) !== null),
    lines.findIndex(({ text }) => YOB_KEYWORD.test(text)),
    lines.findIndex(({ text }) => GENDER_WORD.test(text)),
  ].filter((index) => index > 0);

  const names: Candidate<string>[] = [];
  for (const anchor of new Set(anchors)) {
    const anchorExtent = verticalExtent(lines[anchor]!.words);
    const lineHeight = anchorExtent
      ? anchorExtent.bottom - anchorExtent.top
      : null;
    let below = anchorExtent;

    for (let i = anchor - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (hasGovernmentHeader(line.text) || hasUidaiBranding(line.text)) {
        break;
      }
      const extent = verticalExtent(line.words);
      if (
        extent &&
        below &&
        lineHeight &&
        below.top - extent.bottom > lineHeight * NAME_MAX_LINE_GAP
      ) {
        break;
      }
      if (extent) below = extent;

      const name = asName(line);
      if (name) {
        names.push(name);
        break;
      }
    }
  }
  return names;
}

// --- Address ---------------------------------------------------------------

const MISREAD_RELATION_PREFIX = /^([CSDW])[/|Il][O0](:|(?=[\s,]|$))/;

function joinAddressParts(parts: string[]): string {
  // Wrapped lines continue the same sentence, so they are joined with spaces.
  return normalizeWhitespace(parts.join(" "))
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])(\s*[,;])+/g, "$1")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .replace(MISREAD_RELATION_PREFIX, "$1/O$2");
}

const RULE_GLYPH = /^[|¦!\][]+$/;

function columnWords(words: OcrWord[], left: number, unit: number): OcrWord[] {
  const sorted = words
    .filter((word) => word.bbox && word.bbox.x0 >= left)
    .sort((a, b) => a.bbox!.x0 - b.bbox!.x0);
  const column: OcrWord[] = [];
  const spaces: number[] = [];
  for (const word of sorted) {
    if (RULE_GLYPH.test(word.text)) {
      if (column.length > 0) break;
      continue;
    }
    const previous = column.at(-1);
    const gap = previous ? word.bbox!.x0 - previous.bbox!.x1 : 0;
    if (gap > unit * ADDRESS_MAX_WORD_GAP) break;
    if (
      spaces.length >= 2 &&
      gap > Math.max(unit, median(spaces) * ADDRESS_GAP_TO_SPACE_RATIO)
    ) {
      break;
    }
    if (previous) spaces.push(gap);
    column.push(word);
  }
  return column;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const sameText = (a: string, b: string) =>
  normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase();

function findAddresses(lines: OcrLine[]): Candidate<string>[] {
  for (const [lineIndex, line] of lines.entries()) {
    const labelIndex = line.words.findIndex((word) =>
      ADDRESS_LABEL_WORD.test(word.text),
    );
    if (labelIndex === -1) continue;
    const label = line.words[labelIndex]!;
    if (!label.bbox) return findAddressesByLine(lines);

    const unit = Math.max(1, label.bbox.y1 - label.bbox.y0);
    const left = label.bbox.x0 - unit * ADDRESS_LEFT_TOLERANCE;
    const used: OcrWord[] = [];
    const parts: string[] = [];

    // Text on the label's own line, right of the label (or glued to it).
    const glued = label.text.replace(ADDRESS_LABEL_WORD, "");
    // The label is the column's first word; the rest is the address start.
    const sameLine = columnWords(
      [label, ...line.words.slice(labelIndex + 1)],
      label.bbox.x0,
      unit,
    ).slice(1);
    const first = [glued, ...sameLine.map((word) => word.text)]
      .filter(Boolean)
      .join(" ");
    if (first) {
      if (ADDRESS_STOP.test(first)) return [];
      parts.push(first);
      used.push(label, ...sameLine);
    }

    let previousBottom = label.bbox.y1;
    const below = lines
      .filter((_other, index) => index !== lineIndex)
      .flatMap((other) => {
        const words = columnWords(other.words, left, unit);
        const extent = verticalExtent(words);
        return extent && extent.top > label.bbox!.y0 + unit / 2
          ? [{ words, ...extent }]
          : [];
      })
      // By vertical centre: on a slightly rotated photo a word box can start
      // above the previous line's top, but its centre stays in order.
      .sort((a, b) => a.top + a.bottom - (b.top + b.bottom));

    let added = 0;
    for (const { words, top, bottom } of below) {
      if (added >= MAX_ADDRESS_LINES || HAS_PINCODE.test(parts.join(" ")))
        break;
      if (top - previousBottom > unit * ADDRESS_MAX_LINE_GAP) break;
      const text = words.map((word) => word.text).join(" ");
      if (ADDRESS_STOP.test(text)) break;
      previousBottom = bottom;
      if (parts.some((part) => sameText(part, text))) continue;
      parts.push(text);
      used.push(...words);
      added += 1;
    }
    const address = joinAddressParts(parts);
    return address ? [{ value: address, words: used }] : [];
  }
  return findAddressesByLine(lines);
}

// Fallback for text without word positions: the label line's remainder and
// the following full lines.
function findAddressesByLine(lines: OcrLine[]): Candidate<string>[] {
  const anchor = lines.findIndex(({ text }) => ADDRESS_KEYWORD.test(text));
  if (anchor === -1) return [];

  const firstLine = lines[anchor]!;
  const keyword = firstLine.text.match(ADDRESS_KEYWORD)!;
  const remainder = firstLine.text
    .slice(keyword.index! + keyword[0].length)
    .trim();
  const parts: string[] = [];
  const used: OcrWord[] = [];
  const candidates = [
    { line: firstLine, text: remainder },
    ...lines
      .slice(anchor + 1, anchor + 1 + MAX_ADDRESS_LINES)
      .map((line) => ({ line, text: line.text })),
  ];

  for (const { line, text } of candidates) {
    if (!text) continue;
    if (ADDRESS_STOP.test(text)) break;
    parts.push(text);
    used.push(...wordsIn(line, text));
    if (HAS_PINCODE.test(text)) break;
  }
  const address = joinAddressParts(parts);
  return address ? [{ value: address, words: used }] : [];
}

function findPincode(address: string | null): string | null {
  if (!address) return null;
  const matches = [...address.matchAll(PINCODE)];
  return matches.at(-1)?.[1] ?? null;
}

// --- Confidence ------------------------------------------------------------

// Mean Tesseract confidence of the distinct words the fields came from.
function meanConfidence(words: OcrWord[]): number | null {
  const distinct = [...new Set(words)];
  if (distinct.length === 0) return null;
  const total = distinct.reduce((sum, word) => sum + word.confidence, 0);
  return Math.round(total / distinct.length);
}

// --- Entry point -----------------------------------------------------------

export function parseAadhaar(
  front: OcrResult,
  back: OcrResult,
): AadhaarParseResult {
  const sides = [linesOf(front), linesOf(back)];
  const evidence: [OcrWord[], OcrWord[]] = [[], []];

  // The single distinct value found across both sides, or null when there
  // are none or several. The words behind an accepted value are recorded.
  function resolve<T>(find: (lines: OcrLine[]) => Candidate<T>[]): T | null {
    const found = sides.flatMap((lines, side) =>
      find(lines).map((candidate) => ({ ...candidate, side })),
    );
    if (new Set(found.map((candidate) => candidate.value)).size !== 1) {
      return null;
    }
    for (const candidate of found) {
      evidence[candidate.side]!.push(...candidate.words);
    }
    return found[0]!.value;
  }

  const aadhaarNumber = resolve(findAadhaarNumbers);
  const dateOfBirth = resolve(findDatesOfBirth);
  const yearOfBirth = dateOfBirth
    ? Number(dateOfBirth.slice(-4))
    : resolve(findBirthYears);
  const gender = resolve(findGenders);
  const address = resolve(findAddresses);

  const details: AadhaarDetails = {
    name: resolve(findNames),
    dateOfBirth,
    yearOfBirth,
    gender,
    maskedAadhaarNumber: aadhaarNumber
      ? maskAadhaarNumber(aadhaarNumber)
      : null,
    address,
    pincode: findPincode(address),
  };

  const allText = `${front.text}\n${back.text}`.normalize("NFKC");
  const brandingFound = hasUidaiBranding(allText);
  const headerFound = hasGovernmentHeader(allText);
  const numberEvidenceFound =
    aadhaarNumber !== null || MASKED_NUMBER.test(allText) || sides.some(hasVid);
  const identityFieldsFound =
    dateOfBirth !== null || yearOfBirth !== null || gender !== null;
  const documentDetected =
    (brandingFound &&
      (headerFound || numberEvidenceFound || identityFieldsFound)) ||
    (headerFound && numberEvidenceFound);

  return {
    documentDetected,
    details,
    confidence: {
      front: meanConfidence(evidence[0]),
      back: meanConfidence(evidence[1]),
    },
  };
}
