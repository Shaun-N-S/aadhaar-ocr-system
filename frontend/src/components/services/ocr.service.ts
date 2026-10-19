import axios from 'axios'
import type {
  ApiErrorResponse,
  OcrSuccessResponse,
  UserError,
} from '../types/ocr.types'
import { apiClient } from './api-client'

export async function extractAadhaarDetails(
  frontImage: File,
  backImage: File,
  signal?: AbortSignal,
): Promise<OcrSuccessResponse> {
  const formData = new FormData()
  formData.append('frontImage', frontImage)
  formData.append('backImage', backImage)

  // No Content-Type header: the browser sets multipart/form-data with the
  // correct boundary itself.
  const response = await apiClient.post<OcrSuccessResponse>(
    '/api/ocr',
    formData,
    { signal },
  )

  if (response.data?.success !== true || !response.data.data?.aadhaar) {
    throw new Error('Unexpected response from the server')
  }
  // The whole response body, so the UI can show it exactly as received.
  return response.data
}

function readServerMessage(data: unknown): string | null {
  const message = (data as Partial<ApiErrorResponse> | undefined)?.error
    ?.message
  return typeof message === 'string' && message.trim() ? message : null
}

// The backend prefixes per-image errors with the form field name and doesn't
// end messages with a full stop.
function toDisplayMessage(message: string): string {
  const friendly = message
    .trim()
    .replace(/^frontImage:\s*/, 'Front image: ')
    .replace(/^backImage:\s*/, 'Back image: ')
  return /[.!?]$/.test(friendly) ? friendly : `${friendly}.`
}

/**
 * Turns any error from extractAadhaarDetails into a message for the user.
 * Returns null when the request was cancelled on purpose.
 */
export function toUserError(error: unknown): UserError | null {
  if (axios.isCancel(error)) return null

  if (!axios.isAxiosError(error)) {
    return {
      kind: 'server',
      title: 'Something went wrong',
      message: 'The server sent an unexpected response. Please try again.',
    }
  }

  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return {
      kind: 'network',
      title: 'Request timed out',
      message:
        'The server took too long to respond. Please try again in a moment.',
    }
  }

  if (!error.response) {
    return {
      kind: 'network',
      title: 'Cannot reach the server',
      message:
        'Check your internet connection and that the OCR server is running, then try again.',
    }
  }

  const { status, data } = error.response
  const serverMessage = readServerMessage(data)
  const detail = serverMessage ? toDisplayMessage(serverMessage) : null

  if (status === 400 || status === 413 || status === 415) {
    return {
      kind: 'validation',
      title: 'Please check the images',
      message: detail ?? 'One of the images was rejected.',
    }
  }

  if (status === 422) {
    // Matched on the backend's message, the only signal it provides.
    if (serverMessage && /not appear to be an Aadhaar card/i.test(serverMessage)) {
      return {
        kind: 'not-aadhaar',
        title: 'This does not look like an Aadhaar card',
        message:
          'Upload clear photos of the front and back of an Aadhaar card.',
      }
    }
    const advice =
      serverMessage && /dimensions/i.test(serverMessage)
        ? 'Try a smaller or resized photo.'
        : 'Try a clearer, well-lit photo taken straight on.'
    return {
      kind: 'unreadable',
      title: "We couldn't read the image",
      message: `${detail ?? 'The image could not be processed.'} ${advice}`,
    }
  }

  if (status === 503) {
    return {
      kind: 'busy',
      title: 'The server is busy',
      message: detail ?? 'Please try again in a moment.',
    }
  }

  if (status === 404) {
    return {
      kind: 'server',
      title: 'OCR service not found',
      message: 'The app is not connected to the right server address.',
    }
  }

  return {
    kind: 'server',
    title: 'Something went wrong',
    message: "The server couldn't process the images. Please try again.",
  }
}
