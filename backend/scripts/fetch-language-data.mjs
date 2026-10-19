// Downloads and verifies the Tesseract English model into .tesseract-cache at
// build time, so production never downloads or writes language data at
// runtime. Skips the download when a verified copy is already present.
// Usage: node scripts/fetch-language-data.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(await readFile(path.join(backendDir, "language-data.json"), "utf8"));
const cacheDir = path.join(backendDir, ".tesseract-cache");
const target = path.join(cacheDir, spec.file);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function existingIsValid() {
  try {
    const data = await readFile(target);
    return data.length === spec.size && sha256(data) === spec.sha256;
  } catch {
    return false;
  }
}

if (await existingIsValid()) {
  console.log(`Language data OK: ${path.relative(backendDir, target)} (sha256 verified)`);
  process.exit(0);
}

console.log(`Downloading ${spec.url}`);
const response = await fetch(spec.url);
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status}`);
  process.exit(1);
}
const downloaded = Buffer.from(await response.arrayBuffer());
if (sha256(downloaded) !== spec.downloadSha256) {
  console.error("Download rejected: sha256 does not match language-data.json");
  process.exit(1);
}

const data = gunzipSync(downloaded);
if (data.length !== spec.size || sha256(data) !== spec.sha256) {
  console.error("Decompressed data rejected: size or sha256 does not match language-data.json");
  process.exit(1);
}

// Write to a temporary file first so a partial file is never left in place.
await mkdir(cacheDir, { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, data);
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Language data installed: ${path.relative(backendDir, target)} (sha256 verified)`);
