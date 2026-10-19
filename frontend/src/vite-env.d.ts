/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin without the /api prefix, e.g. http://localhost:5000 */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
