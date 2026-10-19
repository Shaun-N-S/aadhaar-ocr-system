// Mirrors the backend's upload rules so most mistakes are caught before
// uploading. The backend still validates everything, including file content.

export const MAX_IMAGE_SIZE_MB = 5
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024

const ALLOWED_TYPES: Record<string, readonly string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
}

export const ACCEPTED_FILE_TYPES = 'image/jpeg,image/png,.jpg,.jpeg,.png'

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Returns an error message, or null if the file can be uploaded. */
export function validateImageFile(file: File): string | null {
  const extensions = ALLOWED_TYPES[file.type]
  if (!extensions) {
    return 'Only JPEG and PNG images are allowed.'
  }

  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  if (!extensions.includes(extension)) {
    return `The file name must end in ${extensions.join(' or ')} for this image type.`
  }

  if (file.size === 0) {
    return 'This file is empty.'
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return `This image (${formatFileSize(file.size)}) is larger than the ${MAX_IMAGE_SIZE_MB} MB limit.`
  }

  return null
}
