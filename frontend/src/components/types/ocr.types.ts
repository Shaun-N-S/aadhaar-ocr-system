// Mirrors the backend's POST /api/ocr contract.

export type Gender = 'Male' | 'Female' | 'Transgender'

/** Every field is null when the backend could not read it reliably. */
export interface AadhaarDetails {
  name: string | null
  /** DD/MM/YYYY */
  dateOfBirth: string | null
  yearOfBirth: number | null
  gender: Gender | null
  /** Masked by the backend, e.g. "XXXX XXXX 1234". */
  maskedAadhaarNumber: string | null
  address: string | null
  pincode: string | null
}

export interface OcrResultData {
  message: string
  aadhaar: AadhaarDetails
  /**
   * Per image, Tesseract's mean confidence (0–100) for the words the fields
   * were read from; null if no field came from that image. Not a probability
   * that the fields are correct.
   */
  ocrConfidence: { front: number | null; back: number | null }
}

export interface OcrSuccessResponse {
  success: true
  data: OcrResultData
}

export interface ApiErrorResponse {
  success: false
  error: { message: string }
}

export type ImageSide = 'front' | 'back'

export type UserErrorKind =
  | 'validation'
  | 'unreadable'
  | 'not-aadhaar'
  | 'busy'
  | 'network'
  | 'server'

export interface UserError {
  kind: UserErrorKind
  title: string
  message: string
}
