# Aadhaar OCR System

Reads the front and back images of an Aadhaar card and returns the printed
details as structured JSON. The backend uses Node.js, Express, TypeScript and
Tesseract.js (on-device OCR, with no external OCR API). The frontend is a
React + Vite + TypeScript app for uploading both images and viewing the
results.

## Running the backend

Requires Node.js 22.2 or later, for `zlib.crc32` (declared in `engines`; the
repo's `.nvmrc` pins Node 24, which it was developed and tested on).

```bash
cd backend
npm install
cp .env.example .env      # adjust if needed
npm run dev               # development, auto-reload (tsx)
# or
npm run build && npm start
```

Other scripts: `npm run typecheck`, `npm run fetch:lang-data`.

**English language model.** The model (`eng.traineddata`, about 5 MB) lives in
`backend/.tesseract-cache/`, which is git-ignored.
- In **development** it is downloaded from the jsDelivr CDN the first time OCR
  runs.
- `npm run build` runs `npm run fetch:lang-data`, which downloads it from a
  pinned URL and verifies its SHA-256 against `backend/language-data.json`. A
  verified copy that is already present is not downloaded again.
- In **production** (`NODE_ENV=production`) only that verified file is used:
  nothing is downloaded or written at runtime, and a missing or corrupted file
  makes `/api/ready` report "language data is missing or invalid".

### Configuration (`backend/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `NODE_ENV` | `development` | `production` uses only the build-time language data and requires `FRONTEND_URL`. Unexpected errors always return a generic message, whatever this is set to. |
| `FRONTEND_URL` | `http://localhost:5173`, outside production only | The only origin allowed by CORS. **Required in production.** Reduced to its origin, so `https://a.com/` becomes `https://a.com`. |
| `MAX_UPLOAD_SIZE_MB` | `5` | Maximum size of each image (max 20) |
| `OCR_WORKER_COUNT` | `1` | OCR jobs that may run in parallel (1–4) |
| `OCR_MAX_QUEUE` | `8` | OCR jobs running, waiting or reserved (min 2). Each request reserves 2 before its upload is read; beyond this, uploads are refused with 503 before any file data is buffered. |
| `OCR_TIMEOUT_MS` | `30000` | Time limit per image, from the moment a worker is free |
| `OCR_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for a free worker (503 "busy" after that). Must be at least `OCR_TIMEOUT_MS`, and together with it at most 110000, so requests finish before the frontend's 120 s timeout. |
| `OCR_MAX_IMAGE_DIMENSION` | `6000` | Maximum width or height in pixels |

## Running the frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

Other scripts: `npm run build`, `npm run lint`, `npm run preview`.

The backend address comes from `VITE_API_BASE_URL` (default
`http://localhost:5000`, without `/api`). To change it, copy
`frontend/.env.example` to `frontend/.env.local`.

The dev server always uses port 5173 (`strictPort`), because the backend only
accepts requests from `FRONTEND_URL` (default `http://localhost:5173`). If you
serve the frontend from another address, set `FRONTEND_URL` in `backend/.env`
to match.

After an image is chosen, a crop editor opens. It has a card-shaped frame you
can drag, zoom and rotation controls, and a live preview. Applying a crop
creates a new image at the source's full resolution, in the same format
(PNG stays PNG, JPEG stays JPEG), and that file is what gets uploaded. You
can instead keep the full image. Extraction stays disabled until both sides
are confirmed.

The frontend checks file type (JPEG/PNG with a matching extension) and size
(5 MB) before uploading, and checks the 5 MB limit again on the cropped file.

Results can be viewed as **Extracted Data** (labelled fields) or as **JSON
View**, which shows the response body from `POST /api/ocr` formatted with
two-space indentation, with a Copy JSON button. The JSON contains exactly what
the API returned, including the masked number (or `null`); the frontend never
unmasks or adds to it. On Windows, the copied text gets Windows-style line
endings from the clipboard. The backend validates everything again. Selected
images, previews and results exist only in page memory. They are never written
to `localStorage`/`sessionStorage` and are cleared by Reset.

## Deploying (controlled demo)

The backend and frontend are deployed separately. Both need HTTPS from the
hosting platform or a reverse proxy; the app itself serves plain HTTP.

**Backend**

Node 22.2 or later; at least 1 GB RAM for one OCR worker. One worker peaked
around 600 MB on the largest permitted images.

```bash
cd backend
npm ci                      # dev dependencies are needed for the build
npm run build               # compiles, then downloads and verifies eng.traineddata
npm start
```

- **Environment:**
  - `NODE_ENV=production`
  - `FRONTEND_URL=https://<frontend origin>`
  - `PORT`, if the platform assigns one
  - the OCR variables above, if not using the defaults
- **The deployed artifact must include `backend/.tesseract-cache/`,** which the
  build creates. Production never downloads it.
- **Probes:** liveness on `GET /api/health`, readiness on `GET /api/ready`.
- **Shutdown:**
  - On SIGTERM or SIGINT, queued OCR work is refused, running images finish,
    the workers are terminated, and the process exits.
  - The process forcibly exits after `OCR_TIMEOUT_MS` + 5 s (35 s by default).
    Configure the platform to wait at least that long before killing it, or
    lower `OCR_TIMEOUT_MS`.
- **No rate limiting is built in.** For anything beyond a controlled demo, add
  per-IP limits at the platform or proxy.

**Frontend**

```bash
cd frontend
VITE_API_BASE_URL=https://<api host> npm ci && npm run build   # serve dist/ over HTTPS
```

`VITE_API_BASE_URL` is built into the bundle. If it is unset, the build falls
back to `http://localhost:5000`.

## API

### `GET /api/health`

```json
{ "success": true, "data": { "status": "ok", "timestamp": "2026-01-01T00:00:00.000Z" } }
```

Liveness only: the HTTP server is running. It does no OCR work.

### `GET /api/ready`

Readiness: whether an OCR engine has started successfully. It never runs
recognition. The server starts an engine in the background at startup.
- **200:** `{ "success": true, "data": { "status": "ready" } }`
- **503:** `{ "success": false, "error": { "message": "…" } }`, with one of:
  - "OCR engine is starting"
  - "OCR language data is missing or invalid"
  - "OCR engine could not start"
  - "Server is shutting down"

  A failed start is retried at most every 30 s.

### `POST /api/ocr`

Runs OCR on both sides of the card and returns the parsed details. Both images
must be sent in the same request.

**Request:** `multipart/form-data` with exactly these two file fields and
nothing else:

| Field | Required | Content |
|---|---|---|
| `frontImage` | yes | JPEG or PNG of the front of the card |
| `backImage` | yes | JPEG or PNG of the back of the card |

- Each file must be at most `MAX_UPLOAD_SIZE_MB` (default 5 MB) and at most
  `OCR_MAX_IMAGE_DIMENSION` pixels (default 6000) in width and height.
- The file name must have a matching extension (`.jpg`, `.jpeg`, `.png`), and
  the file's actual bytes must match its declared type.
- The front and back must be different images.

```bash
curl -F "frontImage=@front.jpg" -F "backImage=@back.png" http://localhost:5000/api/ocr
```

**Success (200)**, with fictional, masked data:

```json
{
  "success": true,
  "data": {
    "message": "Aadhaar details extracted successfully",
    "aadhaar": {
      "name": "Sample Person",
      "dateOfBirth": "01/01/1990",
      "yearOfBirth": 1990,
      "gender": "Female",
      "maskedAadhaarNumber": "XXXX XXXX 1234",
      "address": "12 Example Street, Sample Nagar, Bengaluru, Karnataka - 560001",
      "pincode": "560001"
    },
    "ocrConfidence": { "front": 91, "back": 87 }
  }
}
```

- Any field that is not found, or is ambiguous, is `null`. Values are never
  guessed or filled with defaults.
- `dateOfBirth` is `DD/MM/YYYY`. `yearOfBirth` comes from the date of birth, or
  from a printed "Year of Birth" when the card shows only the year.
- `ocrConfidence` is, per image, Tesseract's mean confidence (0–100) for the
  words the returned fields were read from, or `null` if no field came from
  that image. Unrelated text, such as Hindi text the English model misreads,
  doesn't lower it. It describes how clearly that text was recognized; it is
  not the probability that a field is correct.

**Errors** always have the form
`{ "success": false, "error": { "message": "..." } }`. When the error relates
to one image, the message starts with its field name.

| Status | When |
|---|---|
| 400 | Missing image, unexpected or extra field, empty file, identical images, malformed multipart body |
| 413 | An image exceeds `MAX_UPLOAD_SIZE_MB` |
| 415 | Not a JPEG/PNG, or the file content doesn't match its declared type |
| 422 | Image can't be decoded, dimensions too large, no readable text, or the text doesn't look like an Aadhaar card |
| 503 | OCR is busy (queue full), timed out, or temporarily unavailable; retry later |
| 500 | Unexpected server error (details are hidden in production) |

## How fields are extracted

Each field is searched on both images (in case the user swapped them) and is
returned only when exactly one distinct value is found.

- **Aadhaar number:** a 12-digit number printed in groups of four (or as 12
  consecutive digits). It must start with 2–9 and pass the Verhoeff checksum
  that UIDAI uses for every Aadhaar number. Lines mentioning "VID" are skipped,
  and 16-digit VIDs, 10-digit phone numbers and 6-digit PIN codes don't match.
  Up to one commonly misread character per group (`O`→`0`, `I`/`l`/`|`→`1`,
  `S`→`5`, `B`→`8`) is corrected; the checksum then confirms the correction.
  Only the masked form is returned.
- **Date of birth / year of birth:** a date (`DD/MM/YYYY`, `DD-MM-YYYY` or
  `DD.MM.YYYY`) on a line with a "DOB" or "Date of Birth" label. On bilingual
  cards OCR often garbles the English half of "जन्म तिथि/DOB:", so a date that
  directly follows a short "/label:" is also accepted. When OCR wraps the label
  onto its own line (ending in "DOB:" or "Date of Birth"), a line holding only
  the date directly below it is accepted. Lines about issue, download or print
  dates are ignored, and so are sentences that merely mention a date of birth. The date must exist on the calendar,
  fall after 1900 and not be in the future. "Year of Birth" / "YOB" lines give
  the year only.
- **Gender:** the words `MALE`, `FEMALE` or `TRANSGENDER`. If more than one
  appears, the result is `null`.
- **Name:** the date-of-birth, year-of-birth and gender lines are used as
  anchors. Above each anchor, lines are checked upward (not a fixed number of
  lines) until the "Government of India"/UIDAI heading or a large vertical gap,
  and the first line that looks like a name is taken. A name:
  - contains only letters, spaces, dots and apostrophes, at most 5 words, every
    word starting with a capital letter
  - contains no label, heading, relation ("S/O", "Father") or disclaimer words
  - has a mean word confidence of at least 60

  Stray edge characters from OCR (such as "|", or a photo edge read as "I")
  are removed first. A fragment such as "ar Test", where OCR lost the start of
  the name, is rejected rather than returned. If anchors point to different
  names, or none is found, the name is `null`.
- **Address and PIN code:** the words after the "Address" label and, below it,
  only words that start at or right of the label's position. This excludes the
  Hindi address printed in the column beside it, which OCR often merges into
  the same lines. Lines are read top to bottom and joined with spaces, until
  the PIN code, the Aadhaar number, a VID, UIDAI contact details, a large
  vertical gap, or 6 lines. The PIN code is the last 6-digit number in the
  address.
- **Is it an Aadhaar card at all?** This is decided separately from field
  extraction, so a masked or unreadable number doesn't reject an otherwise
  clear card. One of these must hold:
  - UIDAI branding ("Unique Identification Authority" or "UIDAI") plus any one
    of: the "Government of India" header, number evidence, or an identity
    field (date of birth, year of birth or gender).
  - The "Government of India" header plus number evidence.

  Number evidence is a checksum-valid number, a masked number such as
  `XXXX XXXX 1234`, or a VID. The word "Aadhaar" never counts, because forms
  and receipts can contain it. If neither holds, the request fails with 422.
  A valid checksum only rules out misreads; it doesn't prove a card is genuine.

  The fixed phrases ("Unique Identification Authority", "UIDAI", "Government
  of India", "VID", "Virtual ID") tolerate small OCR errors:
  - ligatures such as "ﬁ" are normalized;
  - `l`, `1`, `|` and `!` read for "I", `0` read for "O", and "rn" read for
    "m" are allowed;
  - one further wrong character is allowed in words of 6+ letters, with at
    most 2 per phrase.

  No other text is matched loosely.
- **Masked numbers** (as on masked e-Aadhaar) are returned as `null` for
  `maskedAadhaarNumber`. The hidden digits are never reconstructed; all other
  fields are still extracted.

**Orientation.** JPEG orientation metadata from phones is applied in both
byte orders. If the first OCR pass reads fewer than 4 words confidently, the
image is retried at 90°, 180° and 270°, stopping at the first one that reads
well. All passes share the per-image time limit.

**Number recovery.** OCR normally reads each image as a single block of text,
which often misses the large printed Aadhaar number. If a pass yields no
checksum-valid or masked number, one extra pass with automatic layout
analysis looks for it. Only that pass's number and VID lines are added; every
other field still comes from the first pass. The extra pass shares the
per-image time limit, and if it fails, the first pass's result is kept. Images
that need it take about twice as long to process.

## Privacy

- Images are held only in memory for the duration of the request. They are
  never written to disk or a database. The only file the backend writes is
  the downloaded OCR language model.
- Nothing is persisted: there is no database, and OCR text and parsed details
  are discarded once the response is sent.
- Raw OCR text is never returned or logged. The full Aadhaar number is never
  returned; only `XXXX XXXX` plus the last four digits.
- Server logs contain only startup messages and errors. Errors never include
  image content or extracted personal details.
- The response itself contains personal details (name, date of birth, address),
  so it should only be sent over HTTPS in any real deployment.

## Known limitations

- **OCR accuracy is not guaranteed.** Results depend heavily on photo quality,
  lighting, angle, glare and resolution. There is no image preprocessing
  (contrast, resizing, perspective correction). Misread characters, such as
  "Bengalury" for "Bengaluru", are returned as read and are not corrected.
- **English only.** The Hindi text on the card is not read. It can appear as
  garbled Latin characters, which the parser ignores where it can.
- **Layout assumptions.** The parser expects the standard card layout: the name
  directly above the DOB line and an "Address:" label on the back. Other layouts
  (e.g. some e-Aadhaar PDFs, PVC cards or regional layouts) may produce `null`
  fields.
- **Names** with characters other than letters, dots and apostrophes, or name
  lines Tesseract reads with low confidence, are returned as `null`.
- **Addresses** need an "Address" label that OCR can read. A layout with the
  English address to the left of other text may still pick up that text.
- **Mirrored photos** (EXIF orientations 2, 4, 5 and 7) are not corrected.
- **Rotated images** take up to 4 OCR passes per image and are slower.
- **Badly degraded images** can be rejected as "not an Aadhaar card" when too
  few of the detection signals can be read.
- **Merged pages are not supported as a single upload.** The API takes two
  separate images, and identical uploads are rejected. For an A4 e-Aadhaar
  page holding both card sides, select the page for each side and use the
  crop editor to frame the front card and the back card separately. If the
  whole page is sent, OCR merges the two cards' side-by-side lines, and the
  name and address are often returned as `null`. Supporting that properly
  (splitting the page into card regions) is a separate feature.
- **Not proof of authenticity.** A valid checksum doesn't prove the card is
  genuine; this system only reads what is printed.
- **Time per request.** Both images go through a shared OCR queue. A request
  takes roughly the time of two OCR runs, and a client disconnecting doesn't
  cancel OCR that has already started.
