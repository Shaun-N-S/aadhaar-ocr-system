# Aadhaar OCR System

A web app that reads the front and back images of an Aadhaar card with OCR
and returns the printed details (name, date of birth, gender, masked Aadhaar
number, address and PIN code) as structured data.

## Features

- Upload the front and back images (JPEG or PNG, up to 5 MB each)
- Crop editor with drag, zoom and rotate, or use the full image
- File type and size checks in the browser and again on the server
- OCR runs on the server with Tesseract.js; no external OCR service
- Results shown as labelled fields or as JSON, with a Copy JSON button
- Only a masked Aadhaar number is returned (`XXXX XXXX 1234`)
- Fields that cannot be read reliably are returned as `null`, not guessed

## Tech stack

- **Frontend:** React, TypeScript, Vite, Axios, react-easy-crop
- **Backend:** Node.js, Express, TypeScript, Multer, Zod
- **OCR:** Tesseract.js (English language model)

## Prerequisites

- Node.js 22.2 or later (the repo's `.nvmrc` uses Node 24)
- npm

## Getting started

Run the backend and the frontend in two separate terminals.

**Terminal 1 – backend** (runs on http://localhost:5000)

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

**Terminal 2 – frontend** (runs on http://localhost:5173)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

The first OCR request downloads the English language model (about 5 MB) into
`backend/.tesseract-cache/`.

**Other scripts**

| Where | Command | What it does |
|---|---|---|
| backend | `npm run typecheck` | Type-check the code |
| backend | `npm run build` | Compile to `dist/` and download and verify the language model |
| backend | `npm start` | Run the compiled server |
| frontend | `npm run build` | Type-check and build into `dist/` |
| frontend | `npm run lint` | Run ESLint |
| frontend | `npm run preview` | Serve the built frontend locally |

## Environment variables

**Backend** (`backend/.env`, copied from `backend/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `5000` | Port the API listens on |
| `FRONTEND_URL` | `http://localhost:5173` | The only origin allowed by CORS. **Required in production.** |
| `MAX_UPLOAD_SIZE_MB` | `5` | Maximum size of each image (up to 20) |
| `OCR_WORKER_COUNT` | `1` | OCR jobs that run at the same time (1–4) |
| `OCR_MAX_QUEUE` | `8` | Images that can be running or waiting; more are refused with 503 |
| `OCR_TIMEOUT_MS` | `30000` | Time limit for OCR on one image |
| `OCR_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for a free OCR worker. Must be at least `OCR_TIMEOUT_MS`; the two together must be at most 110000. |
| `OCR_MAX_IMAGE_DIMENSION` | `6000` | Maximum image width or height in pixels |

**Frontend** (`frontend/.env.local`, based on `frontend/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000` | Backend address, without `/api`. It is built into the bundle, so set it before `npm run build`. |

The frontend dev server always uses port 5173, because that is the backend's
default `FRONTEND_URL`.

## API

### `POST /api/ocr`

Send both images in one `multipart/form-data` request:

| Field | Required | Content |
|---|---|---|
| `frontImage` | yes | JPEG or PNG of the card front |
| `backImage` | yes | JPEG or PNG of the card back |

```bash
curl -F "frontImage=@front.jpg" -F "backImage=@back.jpg" http://localhost:5000/api/ocr
```

**Success (200)** — example with made-up data:

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

**Errors** use the shape `{ "success": false, "error": { "message": "..." } }`:

| Status | Meaning |
|---|---|
| 400 | Missing, extra, empty or identical images |
| 413 | An image is larger than `MAX_UPLOAD_SIZE_MB` |
| 415 | Not a JPEG/PNG, or the content does not match the file type |
| 422 | Image unreadable, too large in pixels, or not an Aadhaar card |
| 503 | Server busy, OCR timed out or not ready — try again later |
| 500 | Unexpected server error |

### Health checks

- `GET /api/health` — returns 200 when the server is running.
- `GET /api/ready` — returns 200 when the OCR engine has started, otherwise
  503 with a reason (for example, starting or language data missing).

## Limitations and privacy

**Limitations**

- OCR can misread text, especially in small, blurred, dark or angled photos.
  Always check the results against the card.
- Only English text is read; Hindi and other regional text is ignored.
- The parser expects the standard Aadhaar card layout. Other layouts may
  return `null` fields.
- Small crops are enlarged in the browser before upload to help OCR. Images
  sent with "Use full image" are uploaded unchanged.
- A valid Aadhaar number checksum does not prove that a card is genuine.

**Privacy**

- Uploaded images are kept in memory only for the request; they are not saved
  to disk or a database.
- The full Aadhaar number and raw OCR text are never returned.
- Server logs contain only startup, shutdown and error messages, not images
  or extracted details.
- The frontend keeps images and results in page memory only and clears them
  on Reset.
- Responses contain personal details, so use HTTPS in any real deployment.

## Deployment

The frontend and backend are deployed separately. This repository does not
include a live deployment.

**Backend**

```bash
cd backend
npm ci
npm run build   # also downloads and verifies the language model
npm start
```

- Set `NODE_ENV=production` and `FRONTEND_URL=https://<your-frontend-domain>`.
- Keep the `backend/.tesseract-cache/` folder created by the build. In
  production the model is never downloaded at runtime.
- Use `GET /api/health` and `GET /api/ready` as health checks.
- Allow about 1 GB of RAM per OCR worker.
- There is no built-in rate limiting; add it at your hosting platform or proxy
  if needed.

**Frontend**

```bash
cd frontend
npm ci
VITE_API_BASE_URL=https://<your-backend-domain> npm run build
```

Serve the `frontend/dist/` folder over HTTPS.
