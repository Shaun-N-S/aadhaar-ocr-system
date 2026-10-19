import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, RotateCcw, ScanText, ShieldCheck } from 'lucide-react'
import { ErrorAlert } from '../common/ErrorAlert'
import { OcrResults } from '../results/OcrResults'
import { extractAadhaarDetails, toUserError } from '../services/ocr.service'
import type { ImageSide, OcrSuccessResponse, UserError } from '../types/ocr.types'
import { CropEditorDialog } from '../upload/CropEditorDialog'
import { createCroppedFile, type CropSettings } from '../upload/crop-image'
import {
  ImageUploadField,
  type ImageAsset,
  type SideImage,
} from '../upload/ImageUploadField'
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGE_SIZE_MB,
  formatFileSize,
  validateImageFile,
} from '../upload/image-validation'

type Status = 'idle' | 'processing' | 'success' | 'error'

interface CropSession {
  side: ImageSide
  /** The confirmed image to restore if a replacement is cancelled. */
  restore: SideImage | null
}

const SIDES: readonly ImageSide[] = ['front', 'back']
const LABELS: Record<ImageSide, string> = {
  front: 'Front of card',
  back: 'Back of card',
}
const NO_IMAGES: Record<ImageSide, SideImage | null> = {
  front: null,
  back: null,
}
const NO_ERRORS: Record<ImageSide, string | null> = { front: null, back: null }

function fieldId(side: ImageSide): string {
  return `${side}-image`
}

// Privacy: images and results stay in component state only. Never log them or
// write them to browser storage.
export function AadhaarOcrPage() {
  const [images, setImages] = useState(NO_IMAGES)
  const [cropSession, setCropSession] = useState<CropSession | null>(null)
  const [fieldErrors, setFieldErrors] = useState(NO_ERRORS)
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<OcrSuccessResponse | null>(null)
  const [requestError, setRequestError] = useState<UserError | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const liveUrlsRef = useRef(new Set<string>())
  const focusAfterCropRef = useRef<ImageSide | null>(null)

  const isProcessing = status === 'processing'
  const frontFile = images.front?.output?.file
  const backFile = images.back?.output?.file
  const missingSides = SIDES.filter((side) => !images[side])
  const pendingSides = SIDES.filter((side) => images[side] && !images[side].output)
  const canSubmit =
    Boolean(frontFile && backFile) && cropSession === null && !isProcessing

  // Release object URLs as soon as no image (or cancellable replacement)
  // refers to them any more.
  useEffect(() => {
    const inUse = new Set<string>()
    for (const image of [images.front, images.back, cropSession?.restore]) {
      if (!image) continue
      inUse.add(image.source.url)
      if (image.output) inUse.add(image.output.url)
    }
    const live = liveUrlsRef.current
    for (const url of live) {
      if (!inUse.has(url)) {
        URL.revokeObjectURL(url)
        live.delete(url)
      }
    }
    for (const url of inUse) live.add(url)
  }, [images, cropSession])

  // ...and release whatever is left when the page unmounts.
  useEffect(() => {
    const live = liveUrlsRef.current
    return () => {
      for (const url of live) URL.revokeObjectURL(url)
      live.clear()
    }
  }, [])

  // Move focus to the results so keyboard and screen-reader users find them.
  useEffect(() => {
    if (result) resultsRef.current?.focus()
  }, [result])

  // After the crop editor closes, return focus to that side's Crop button.
  useEffect(() => {
    const side = focusAfterCropRef.current
    if (cropSession || !side) return
    focusAfterCropRef.current = null
    document.getElementById(`${fieldId(side)}-crop`)?.focus()
  }, [cropSession])

  function clearOutcome() {
    setResult(null)
    setRequestError(null)
    setStatus('idle')
  }

  function updateImage(side: ImageSide, image: SideImage | null) {
    setImages((current) => ({ ...current, [side]: image }))
  }

  function selectImage(side: ImageSide, file: File) {
    const error = validateImageFile(file)
    setFieldErrors((current) => ({ ...current, [side]: error }))
    if (error) return

    const previous = images[side]
    const source: ImageAsset = { file, url: URL.createObjectURL(file) }
    updateImage(side, { source, output: null, crop: null })
    // Open the editor straight away; cancelling it brings back the previously
    // confirmed image, if there was one.
    setCropSession({ side, restore: previous?.output ? previous : null })
    // A previous result no longer matches the selected images.
    clearOutcome()
  }

  function openCropEditor(side: ImageSide) {
    if (images[side]) setCropSession({ side, restore: null })
  }

  function cancelCrop() {
    if (!cropSession) return
    if (cropSession.restore) updateImage(cropSession.side, cropSession.restore)
    focusAfterCropRef.current = cropSession.side
    setCropSession(null)
  }

  async function applyCrop(
    settings: CropSettings,
    decodedImage: HTMLImageElement,
  ): Promise<string | null> {
    const session = cropSession
    const image = session && images[session.side]
    if (!session || !image) return 'The image is no longer available.'

    let file: File
    try {
      file = await createCroppedFile(image.source.file, decodedImage, settings)
    } catch {
      return "Your browser couldn't create the cropped image. Try a smaller crop or use the full image."
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return `The cropped image is ${formatFileSize(file.size)}, which is over the ${MAX_IMAGE_SIZE_MB} MB limit. Crop a smaller area${
        file.type === 'image/png' ? ', or use a JPEG photo instead' : ''
      }.`
    }
    const error = validateImageFile(file)
    if (error) return error

    updateImage(session.side, {
      ...image,
      output: { file, url: URL.createObjectURL(file) },
      crop: settings,
    })
    focusAfterCropRef.current = session.side
    setCropSession(null)
    clearOutcome()
    return null
  }

  function confirmFullImage(side: ImageSide) {
    const image = images[side]
    if (!image) return
    updateImage(side, { ...image, output: image.source, crop: null })
    clearOutcome()
  }

  function removeImage(side: ImageSide) {
    updateImage(side, null)
    setFieldErrors((current) => ({ ...current, [side]: null }))
    clearOutcome()
  }

  function reset() {
    abortRef.current?.abort()
    abortRef.current = null
    setImages(NO_IMAGES)
    setCropSession(null)
    setFieldErrors(NO_ERRORS)
    clearOutcome()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // The ref guards against a double click before the button re-renders.
    if (!frontFile || !backFile || cropSession || abortRef.current) return

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('processing')
    setResult(null)
    setRequestError(null)

    try {
      const response = await extractAadhaarDetails(
        frontFile,
        backFile,
        controller.signal,
      )
      setResult(response)
      setStatus('success')
    } catch (error) {
      const userError = toUserError(error)
      // null means the request was cancelled by Reset, which already
      // cleared the state.
      if (userError) {
        setRequestError(userError)
        setStatus('error')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function statusMessage(): string {
    if (isProcessing) return 'Reading both images. This can take up to a minute.'
    if (canSubmit || status !== 'idle') return ''
    if (missingSides.length > 0) return 'Select both images to continue.'
    if (pendingSides.length > 0) {
      const names = pendingSides.map((side) => LABELS[side].toLowerCase())
      return `Confirm the ${names.join(' and ')}: crop it or use the full image.`
    }
    return ''
  }

  const editedImage = cropSession ? images[cropSession.side] : null

  return (
    <main className="page">
      <header className="page__header">
        <div className="page__icon" aria-hidden="true">
          <ScanText size={28} />
        </div>
        <h1>Aadhaar OCR</h1>
        <p className="page__intro">
          Upload clear photos of the front and back of an Aadhaar card, and
          crop each one to the card. The printed details are read
          automatically and shown below, with the Aadhaar number masked.
        </p>
        <p className="page__privacy">
          <ShieldCheck aria-hidden="true" size={16} />
          Images are processed in memory and are not stored.
        </p>
      </header>

      <form className="card" onSubmit={handleSubmit} aria-busy={isProcessing} noValidate>
        <div className="upload-grid">
          {SIDES.map((side) => (
            <ImageUploadField
              key={side}
              id={fieldId(side)}
              label={LABELS[side]}
              hint={
                side === 'front'
                  ? 'The side with your photo'
                  : 'The side with your address'
              }
              image={images[side]}
              error={fieldErrors[side]}
              disabled={isProcessing}
              onSelect={(file) => selectImage(side, file)}
              onCrop={() => openCropEditor(side)}
              onUseFullImage={() => confirmFullImage(side)}
              onRemove={() => removeImage(side)}
            />
          ))}
        </div>

        <div className="form-actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={!canSubmit}
          >
            {isProcessing ? (
              <Loader2 aria-hidden="true" size={18} className="spin" />
            ) : (
              <ScanText aria-hidden="true" size={18} />
            )}
            {isProcessing ? 'Reading images…' : 'Extract details'}
          </button>
          <button type="button" className="button button--secondary" onClick={reset}>
            <RotateCcw aria-hidden="true" size={18} />
            {isProcessing ? 'Cancel and reset' : 'Reset'}
          </button>
        </div>

        <p className="form-status" role="status">
          {statusMessage()}
        </p>
      </form>

      {cropSession && editedImage && (
        <CropEditorDialog
          key={editedImage.source.url}
          title={`Crop ${LABELS[cropSession.side].toLowerCase()}`}
          imageUrl={editedImage.source.url}
          initialSettings={editedImage.crop}
          onApply={applyCrop}
          onCancel={cancelCrop}
        />
      )}

      {requestError && <ErrorAlert error={requestError} />}

      {result && (
        <div ref={resultsRef} tabIndex={-1} className="results-wrapper">
          <OcrResults response={result} />
        </div>
      )}
    </main>
  )
}
