import { crc32 } from "node:zlib";
import type { ImageDimensions, ImageFormat } from "../types/ocr.types";

const SIGNATURES: Record<ImageFormat, readonly number[]> = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  for (const [format, signature] of Object.entries(SIGNATURES)) {
    if (
      buffer.length >= signature.length &&
      signature.every((byte, i) => buffer[i] === byte)
    ) {
      return format as ImageFormat;
    }
  }
  return null;
}

// Reads width/height from the header only, without decoding pixels, so huge
// images can be rejected before anything allocates memory for them.
// Returns null if the header is truncated or inconsistent.
export function readImageDimensions(
  buffer: Buffer,
  format: ImageFormat,
): ImageDimensions | null {
  const dimensions =
    format === "png" ? readPngDimensions(buffer) : readJpegDimensions(buffer);
  return dimensions && dimensions.width > 0 && dimensions.height > 0
    ? dimensions
    : null;
}

// PNG: 8-byte signature, then the IHDR chunk (length 13) holding width and
// height. Its CRC is verified so a damaged header is not trusted.
function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  const IHDR_END = 33;
  if (
    buffer.length < IHDR_END ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("latin1", 12, 16) !== "IHDR" ||
    crc32(buffer.subarray(12, 29)) !== buffer.readUInt32BE(29)
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface ExifOrientation {
  /** EXIF Orientation tag value, 1–8 (1 = upright). */
  value: number;
  /** Byte offset of the 2-byte value within the file. */
  offset: number;
  littleEndian: boolean;
}

const EXIF_HEADER = "Exif\0\0";
const ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

// Reads the Orientation tag from IFD0 of a JPEG's EXIF (APP1) segment, in
// either byte order ("II" little-endian or "MM" big-endian). Returns null if
// there is no valid tag; any malformed structure is treated as absent.
export function readJpegOrientation(buffer: Buffer): ExifOrientation | null {
  if (detectImageFormat(buffer) !== "jpeg") return null;
  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1]!;
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buffer.length) return null;
      marker = buffer[offset + 1]!;
    }
    offset += 2;

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // EXIF always precedes the image data.
    if (marker === 0xd9 || marker === 0xda) return null;

    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;

    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    if (
      marker === 0xe1 &&
      buffer.toString("latin1", segmentStart, segmentStart + 6) === EXIF_HEADER
    ) {
      return readTiffOrientation(buffer, segmentStart + 6, segmentEnd);
    }
    offset += length;
  }
  return null;
}

function readTiffOrientation(
  buffer: Buffer,
  tiffStart: number,
  end: number,
): ExifOrientation | null {
  if (tiffStart + 8 > end) return null;
  const byteOrder = buffer.toString("latin1", tiffStart, tiffStart + 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return null;
  const littleEndian = byteOrder === "II";
  const u16 = (at: number) =>
    littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (at: number) =>
    littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);

  if (u16(tiffStart + 2) !== 42) return null;
  const ifd = tiffStart + u32(tiffStart + 4);
  if (ifd + 2 > end) return null;

  const entries = u16(ifd);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) !== ORIENTATION_TAG) continue;
    // A single SHORT is stored in the first two bytes of the value field.
    if (u16(entry + 2) !== TIFF_SHORT || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8
      ? { value, offset: entry + 8, littleEndian }
      : null;
  }
  return null;
}

// JPEG: walk the marker segments until a start-of-frame (SOFn) segment,
// which holds the height and width.
function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1]!;
    // Any number of 0xFF fill bytes may precede a marker.
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buffer.length) return null;
      marker = buffer[offset + 1]!;
    }
    offset += 2;

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image or start of scan before any frame header: invalid.
    if (marker === 0xd9 || marker === 0xda) return null;

    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;

    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (length < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += length;
  }

  return null;
}
