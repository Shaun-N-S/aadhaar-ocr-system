# Aadhaar OCR — Frontend

React + TypeScript + Vite app for uploading the front and back of an Aadhaar
card, cropping each image, and viewing the extracted details. Setup, the API
contract, privacy behavior and deployment are described in the
[project README](../README.md).

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check and production build into dist/
npm run lint
```

The backend address comes from `VITE_API_BASE_URL` (see `.env.example`). It is
built into the bundle at build time, so set it before `npm run build`.

## Where things are

- `src/components/pages/AadhaarOcrPage.tsx`: page state, submit, cancel, reset
- `src/components/upload/`: file picker, validation, crop editor and crop output
- `src/components/services/`: Axios client and the `POST /api/ocr` call, with
  error-message mapping
- `src/components/results/`: Extracted Data and JSON views
