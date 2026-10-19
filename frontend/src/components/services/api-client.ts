import axios from 'axios'

const DEFAULT_API_BASE_URL = 'http://localhost:5000'

// The backend origin, without the /api prefix.
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') ||
  DEFAULT_API_BASE_URL

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  // OCR of two images can take a while, especially when the server queue is
  // busy; the backend has its own per-image timeout as well.
  timeout: 120_000,
})
