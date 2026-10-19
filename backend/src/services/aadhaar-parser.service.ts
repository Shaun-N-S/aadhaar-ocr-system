import type {
  AadhaarDetails,
  AadhaarParseResult,
  Gender,
} from "../types/aadhaar.types";
import type { OcrLine, OcrResult, OcrWord } from "../types/ocr.types";
import { isValidVerhoeff } from "../utils/verhoeff";

// Parses OCR output from the front and back of an Aadhaar card. Each field is
// searched on both sides (users sometimes swap the images). A field is only
// returned when exactly one distinct value is found; otherwise it is null.
// Nothing here logs: the input and output are personal data.

const DOB_KEYWORD = /\bD[O0]B\b|DATE\s+OF\s+BIRTH/i;
const YOB_KEYWORD = /\bY[O0]B\b|YEAR\s+OF\s+BIRTH/i;
const ADDRESS_KEYWORD = /\bAdd?ress?\b\s*[:;-]?/i;
// "Address" as a single OCR word, possibly with text glued after it.
const ADDRESS_LABEL_WORD = /^Add?ress?\b\s*[:;-]?/i;
const GENDER_WORD = /\b(FEMALE|MALE|TRANSGENDER)\b/i;
// An Aadhaar number printed in masked form, e.g. "XXXX XXXX 1234". Only used
// as evidence; the hidden digits are never reconstructed.
const MASKED_NUMBER = /(?<![\w*])[Xx*]{4}\s?[Xx*]{4}\s?\d{4}(?!\d)/;

// --- Authority phrases, matched with limited OCR tolerance -----------------
// Document detection and a few line checks rely on fixed printed phrases. OCR
// often gets one character wrong ("Authorty", "Govemment", "VlD") or emits a
// ligature ("ﬁ"), so these phrases are matched word by word:
//  - text is NFKC-normalized first, which turns ligatures such as "ﬁ" into
//    their letters;
//  - characters OCR confuses with I and O in printed capitals ("l", "1", "|",
//    "!" and "0"), and "rn" read as "m", are mapped before comparing;
//  - a word of 6+ letters may then differ by one edit (insert, delete or
//    substitute); shorter words must match exactly;
//  - at most 2 edits per phrase.
// The tolerance applies only to the phrases below; the word "Aadhaar" is
// deliberately never used as evidence, because forms and letters mention it.
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

/** Branding of the issuer (UIDAI), printed on Aadhaar cards and letters. */
const hasUidaiBranding = (text: string) => containsPhrase(text, UIDAI_PHRASES);
/** A generic header shared by many government documents. */
const hasGovernmentHeader = (text: string) =>
  containsPhrase(text, GOVERNMENT_PHRASES);
const hasVidLabel = (text: string) => containsPhrase(text, VID_PHRASES);

// Characters Tesseract commonly confuses with digits in printed numbers.
const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  o: "0",
  I: "1",
  l: "1",
  "|": "1",
  S: "5",
  B: "8",
};

// Runs of 4-character groups such as "1234 5678 9012", tolerating lookalikes.
// A 16-digit VID forms a longer run and is therefore never a 12-digit match.
const DIGIT_GROUP_RUN =
  /(?<![\w|])[\dOoIlSB|]{4}(?:[ -]?[\dOoIlSB|]{4})+(?![\w|])/g;
const VID_NUMBER = /\d{4}\s?\d{4}\s?\d{4}\s?\d{4}/;
// DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY, tolerating O/I/l misread for digits.
const DATE =
  /(?<![\dOoIl])([\dOoIl]{1,2})\s?[/.-]\s?([\dOoIl]{1,2})\s?[/.-]\s?([\dOoIl]{4})(?![\dOoIl])/;
// On bilingual cards the label reads "जन्म तिथि/DOB:". OCR often garbles the
// English part ("/pos:", "/poB."), but keeps its shape: a slash, a short
// token and punctuation directly before the date.
const SLASH_LABEL_BEFORE_DATE = /\/\s*[A-Za-z0-9]{2,4}\s*[:.;,]\s*$/;
// A DOB label ending its line, e.g. "…/Date of Birth/DOB:". A trailing full
// stop is not allowed, which excludes sentences such as the card's
// "…not of citizenship or date of birth." disclaimer.
const DOB_LABEL_AT_END = /(?:\bD[O0]B|DATE\s+OF\s+BIRTH)\s*:?\s*$/i;
// Dates that are not a date of birth.
const OTHER_DATE_LABELS =
  /ISSUE|DOWNLOAD|PRINT|GENERAT|VALID|EXPIR|ENROL|UPDATE/i;
const YEAR = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
const PINCODE = /(?<!\d)([1-9]\d{5})(?!\d)/g;
const HAS_PINCODE = /(?<!\d)[1-9]\d{5}(?!\d)/;

// Lines containing these words are labels, headings, relation lines or the
// card's disclaimer, never the cardholder's name.
const NON_NAME_WORDS =
  /GOVERNMENT|INDIA|AADHAA?R|UNIQUE|IDENTIFICATION|AUTHORITY|\bD[O0]B\b|BIRTH|\bY[O0]B\b|FEMALE|\bMALE\b|TRANSGENDER|ADDRESS|\bVID\b|ENROL|PROOF|IDENTITY|CITIZEN|VERIF|AUTHENTICAT|\bQR\b|ISSUE|DOWNLOAD|FATHER|MOTHER|HUSBAND|GUARDIAN|\b[SDWC]\s?\/\s?O\b|^\s*To\b/i;
// Name words with lower Tesseract confidence are usually misread Hindi text.
const MIN_NAME_CONFIDENCE = 60;
// Stop looking for the name above an anchor across a gap larger than this
// many line heights (the name belongs to the same block of details).
const NAME_MAX_LINE_GAP = 3;
const MAX_ADDRESS_LINES = 6;
// Lines after the address: the Aadhaar number (complete or masked), VID, or
// UIDAI contact details.
const ADDRESS_STOP =
  /\bVID\b|UIDAI|www\.|@|AADHAA?R|\d{4}\s?\d{4}\s?\d{4}|[Xx*]{4}\s?[Xx*]{4}\s?\d{4}/i;
// Column and block limits for the address, in multiples of the label height.
const ADDRESS_LEFT_TOLERANCE = 1.5;
const ADDRESS_MAX_LINE_GAP = 2.5;
// A horizontal gap this wide between words is a column gutter, not a space.
const ADDRESS_MAX_WORD_GAP = 3;
// Once a column has a few words, a gap this many times wider than the spaces
// between them (and at least one label height) also ends it: text next to the
// address, such as the QR code read as "words", must not join its line.
const ADDRESS_GAP_TO_SPACE_RATIO = 4;

/** A value found in the text, with the OCR words it was read from. */
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

      // Allow at most one lookalike per group of four, so words made of
      // letters like O, S and B are never read as numbers.
      const groups = raw.match(/.{4}/g) ?? [];
      if (!groups.every((group) => (group.match(/\d/g) ?? []).length >= 3)) {
        continue;
      }

      const digits = replaceLookalikes(raw);
      // Aadhaar numbers never start with 0 or 1 and end in a Verhoeff digit.
      // A valid checksum only rules out misreads; it proves nothing about
      // whether the document is genuine.
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
  return lines.some(
    ({ text }) => hasVidLabel(text) && VID_NUMBER.test(text),
  );
}

// Three or more groups of four digits (or digit lookalikes), as in an
// Aadhaar number or a VID.
const NUMBER_EVIDENCE_RUN =
  /(?<![\w|])[\dOoIlSB|]{4}(?:[ -]?[\dOoIlSB|]{4}){2,}(?![\w|])/;

/**
 * Whether OCR output already holds a checksum-valid or masked Aadhaar number,
 * using the same rules as extraction. The OCR service uses this to decide on
 * a number-recovery pass.
 */
export function hasAadhaarNumberEvidence(result: OcrResult): boolean {
  return (
    findAadhaarNumbers(linesOf(result)).length > 0 ||
    MASKED_NUMBER.test(result.text.normalize("NFKC"))
  );
}

/**
 * Whether a line from a recovery pass may hold number evidence (an Aadhaar or
 * VID number, a masked number, or a VID label) and is worth adding. Added
 * lines still go through all checksum, VID and masking rules.
 */
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

// A line holding the date of birth: a date with either a DOB label (e.g.
// "DOB:", "Date of Birth/DOB:") or the "/label:" shape of a garbled bilingual
// label, and no other kind of date.
function matchDateOfBirth(text: string): RegExpMatchArray | null {
  if (OTHER_DATE_LABELS.test(text)) return null;
  const match = text.match(DATE);
  if (!match) return null;
  const labelled =
    DOB_KEYWORD.test(text) ||
    SLASH_LABEL_BEFORE_DATE.test(text.slice(0, match.index));
  return labelled ? match : null;
}

// OCR sometimes wraps a long label ("जन्म तिथि/Date of Birth/DOB:") onto its
// own line, leaving the date alone on the next one. That pairing is accepted
// only when the label ends its line and the next line holds nothing but the
// date, so sentences that merely mention a date of birth don't qualify.
function matchWrappedDateOfBirth(
  labelText: string,
  dateText: string,
): RegExpMatchArray | null {
  if (!DOB_LABEL_AT_END.test(labelText) || DATE.test(labelText)) return null;
  if (OTHER_DATE_LABELS.test(labelText)) return null;
  const match = dateText.match(DATE);
  const rest = match ? dateText.replace(match[0], "").replace(/[\s:.,;|]/g, "") : "x";
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

// Whether `word`, at the edge of a name line, is OCR noise rather than part of
// the name: a token without letters ("|", "-"), a single lowercase letter, or
// a single character standing well apart from the name (a photo or frame
// edge read as "I" or "l"). A real initial sits at normal word spacing.
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

  // Strip stray punctuation at the edges, e.g. "Ravi Kumar Test,".
  const candidate = normalizeWhitespace(
    words.map((word) => word.text).join(" "),
  ).replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "");
  const parts = candidate.split(" ");
  const looksLikeName =
    /^[A-Za-z][A-Za-z.' ]*[A-Za-z.]$/.test(candidate) &&
    candidate.length <= 60 &&
    parts.length <= 5 &&
    parts.some((part) => /^[A-Za-z]{3,}/.test(part)) &&
    // Names are printed in Title Case or capitals; a lowercase start ("ar
    // Test") means OCR lost part of the name, so the fragment is rejected.
    parts.every((part) => /^[A-Z]/.test(part));
  if (!looksLikeName) return null;

  // Confidence of the name's own words, so noise elsewhere on the line
  // doesn't count against it (or for it).
  const confidence =
    words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
  return confidence >= MIN_NAME_CONFIDENCE ? { value: candidate, words } : null;
}

// The top and bottom of a group of words; words without a box are ignored,
// and null means none had one.
function verticalExtent(words: OcrWord[]): { top: number; bottom: number } | null {
  const boxes = words.map((word) => word.bbox).filter((box) => box !== null);
  if (boxes.length === 0) return null;
  return {
    top: Math.min(...boxes.map((box) => box.y0)),
    bottom: Math.max(...boxes.map((box) => box.y1)),
  };
}

// On the front, the English name is printed above the date of birth (or year
// of birth), which is followed by the gender. Each of those lines that is
// found serves as an anchor. From each anchor the lines above are checked in
// turn, skipping labels, dates and unreadable text, up to the "Government of
// India" heading or a large vertical gap; the first name-like line is that
// anchor's candidate. Anchors that disagree leave the name null.
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

// The relation prefix that starts most addresses ("C/O:", "S/O", "D/O:",
// "W/O"), with its slash misread as I, l or | and/or its O as 0 ("CIO:",
// "S/0:"). Only those two glyphs are corrected, and only when the first
// letter was read as an uppercase C, S, D or W; a misread first letter
// ("5/0:", "$/0:") is ambiguous and left as read.
const MISREAD_RELATION_PREFIX = /^([CSDW])[/|Il][O0](:|(?=[\s,]|$))/;

function joinAddressParts(parts: string[]): string {
  // Wrapped lines continue the same sentence, so they are joined with spaces.
  return normalizeWhitespace(parts.join(" "))
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])(\s*[,;])+/g, "$1")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .replace(MISREAD_RELATION_PREFIX, "$1/O$2");
}

// A printed border or divider, which OCR reads as a "word" such as "|".
const RULE_GLYPH = /^[|¦!\][]+$/;

// The words of one column: starting at `left`, in reading order, up to the
// first gap wide enough to be a gutter, or a printed divider, before another
// column.
function columnWords(words: OcrWord[], left: number, unit: number): OcrWord[] {
  const sorted = words
    .filter((word) => word.bbox && word.bbox.x0 >= left)
    .sort((a, b) => a.bbox!.x0 - b.bbox!.x0);
  const column: OcrWord[] = [];
  const spaces: number[] = [];
  for (const word of sorted) {
    // A divider ends the column; one before the first word is a left border.
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

// Bilingual cards print the Hindi and English addresses side by side, and
// OCR often merges both columns into one line. Using word positions, only
// the column that starts at the "Address" label is kept, line by line from
// top to bottom, until the PIN code, a line that clearly isn't address text,
// a large vertical gap, or a fixed number of lines. A line repeating one
// already taken (duplicated address text) is skipped.
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
      if (added >= MAX_ADDRESS_LINES || HAS_PINCODE.test(parts.join(" "))) break;
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

  // Is this an Aadhaar document? Detection is separate from field extraction:
  // a masked or unreadable number must not reject an otherwise clear card.
  // No single signal is enough. Forms mention "Aadhaar", "Government of
  // India" heads many documents, and any 12-digit number has a 1 in 10 chance
  // of passing the checksum. So either:
  //  - UIDAI branding plus any other evidence, or
  //  - the government header plus evidence of an Aadhaar number (a valid
  //    complete number, a masked "XXXX XXXX 1234" number, or a VID).
  const allText = `${front.text}\n${back.text}`.normalize("NFKC");
  const brandingFound = hasUidaiBranding(allText);
  const headerFound = hasGovernmentHeader(allText);
  const numberEvidenceFound =
    aadhaarNumber !== null ||
    MASKED_NUMBER.test(allText) ||
    sides.some(hasVid);
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
