import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  AlertCircle,
  CircleAlert,
  CircleCheck,
  Crop,
  ImageUp,
  Maximize,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { CropSettings } from './crop-image'
import {
  ACCEPTED_FILE_TYPES,
  MAX_IMAGE_SIZE_MB,
  formatFileSize,
} from './image-validation'

export interface ImageAsset {
  file: File
  /** Object URL for previews; released by the page when no longer used. */
  url: string
}

export interface SideImage {
  source: ImageAsset
  /** The file that will be submitted; null until the user confirms it. */
  output: ImageAsset | null
  /** The crop that produced `output`; null when the full image is used. */
  crop: CropSettings | null
}

interface ImageUploadFieldProps {
  id: string
  label: string
  hint: string
  image: SideImage | null
  error: string | null
  disabled: boolean
  onSelect: (file: File) => void
  onCrop: () => void
  onUseFullImage: () => void
  onRemove: () => void
}

export function ImageUploadField({
  id,
  label,
  hint,
  image,
  error,
  disabled,
  onSelect,
  onCrop,
  onUseFullImage,
  onRemove,
}: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const statusId = `${id}-status`

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Clear the input so choosing the same file again still triggers a change.
    event.target.value = ''
    if (file) onSelect(file)
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    if (!disabled) setIsDragging(true)
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files[0]
    if (file && !disabled) onSelect(file)
  }

  // What the user sees and what will be submitted: the confirmed output, or
  // the chosen image while it still needs confirming.
  const shown = image?.output ?? image?.source ?? null
  const isPending = image !== null && image.output === null

  return (
    <div className="upload-field">
      <div className="upload-field__header">
        <label className="upload-field__label" htmlFor={id}>
          {label}
        </label>
        <span className="upload-field__hint" id={hintId}>
          {hint}
        </span>
      </div>

      <input
        ref={inputRef}
        id={id}
        className="visually-hidden"
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        disabled={disabled}
        // Once an image is chosen, the Replace button is the keyboard control.
        tabIndex={image ? -1 : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        onChange={handleChange}
      />

      {image && shown ? (
        <div
          className={`upload-field__preview${isPending ? ' upload-field__preview--pending' : ''}`}
        >
          <p
            id={statusId}
            className={`badge ${isPending ? 'badge--warning' : 'badge--success'}`}
          >
            {isPending ? (
              <>
                <CircleAlert aria-hidden="true" size={16} />
                Needs confirmation: crop it or use the full image
              </>
            ) : (
              <>
                <CircleCheck aria-hidden="true" size={16} />
                {image.crop ? 'Cropped' : 'Full image'}
              </>
            )}
          </p>
          <img src={shown.url} alt={`Preview of ${label.toLowerCase()}`} />
          <div className="upload-field__meta">
            <span className="upload-field__filename" title={shown.file.name}>
              {shown.file.name}
            </span>
            <span className="upload-field__size">
              {formatFileSize(shown.file.size)}
            </span>
          </div>
          <div className="upload-field__actions">
            <button
              id={`${id}-crop`}
              type="button"
              className={`button ${isPending ? 'button--primary' : 'button--secondary'}`}
              disabled={disabled}
              aria-describedby={statusId}
              onClick={onCrop}
            >
              <Crop aria-hidden="true" size={16} />
              {image.crop ? 'Edit crop' : 'Crop'}
            </button>
            {isPending && (
              <button
                type="button"
                className="button button--secondary"
                disabled={disabled}
                onClick={onUseFullImage}
              >
                <Maximize aria-hidden="true" size={16} />
                Use full image
              </button>
            )}
            <button
              type="button"
              className="button button--secondary"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <RefreshCw aria-hidden="true" size={16} />
              Replace
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" size={16} />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={id}
          className={`dropzone${isDragging ? ' dropzone--active' : ''}${
            disabled ? ' dropzone--disabled' : ''
          }`}
          onDragOver={handleDragOver}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <ImageUp aria-hidden="true" size={32} />
          <span className="dropzone__title">Choose an image or drag it here</span>
          <span className="dropzone__subtitle">
            JPEG or PNG, up to {MAX_IMAGE_SIZE_MB} MB
          </span>
        </label>
      )}

      {error && (
        <p className="field-error" id={errorId} role="alert">
          <AlertCircle aria-hidden="true" size={16} />
          {error}
        </p>
      )}
    </div>
  )
}
