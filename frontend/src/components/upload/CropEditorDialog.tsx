import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react'
import Cropper, { type Area, type Point } from 'react-easy-crop'
import {
  AlertCircle,
  Check,
  Loader2,
  RotateCcw,
  RotateCw,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  CARD_ASPECT_RATIO,
  drawCrop,
  loadImage,
  type CropSettings,
} from './crop-image'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.1
const PREVIEW_MAX_WIDTH = 320
const PREVIEW_MAX_HEIGHT = 220

/** Keeps rotation within -180..180 degrees. */
function normalizeRotation(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

interface CropEditorDialogProps {
  title: string
  imageUrl: string
  /** The previously applied crop, restored when editing it again. */
  initialSettings: CropSettings | null
  /** Creates the cropped file. Resolves to an error message, or null on success. */
  onApply: (settings: CropSettings, image: HTMLImageElement) => Promise<string | null>
  onCancel: () => void
}

export function CropEditorDialog({
  title,
  imageUrl,
  initialSettings,
  onApply,
  onCancel,
}: CropEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const zoomInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const zoomId = useId()
  const rotationId = useId()

  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [rotation, setRotation] = useState(initialSettings?.rotation ?? 0)
  const [settings, setSettings] = useState<CropSettings | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [isOpen, setIsOpen] = useState(false)

  // A modal <dialog> traps focus, makes the page inert, and turns Esc into a
  // 'cancel' event. The cropper is only mounted once the dialog is open: it
  // measures itself on mount, and a closed dialog has no size. (An image that
  // is already decoded loads instantly and would be measured as 0 x 0.)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // Start on the zoom slider; otherwise the browser may focus the editor's
    // scrolling body on small screens.
    zoomInputRef.current?.focus()
    setIsOpen(true)
    return () => dialog.close()
  }, [])

  // The decoded image is needed for the preview and for creating the file.
  useEffect(() => {
    let isCurrent = true
    loadImage(imageUrl).then(
      (loaded) => {
        if (isCurrent) setImage(loaded)
      },
      () => {
        if (isCurrent) setError('This image could not be opened for cropping.')
      },
    )
    return () => {
      isCurrent = false
    }
  }, [imageUrl])

  // Redraw the preview at most once per frame while the crop is moving.
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !image || !settings) return

    const frame = requestAnimationFrame(() => {
      const pixelRatio = window.devicePixelRatio || 1
      const scale = Math.min(
        1,
        (PREVIEW_MAX_WIDTH * pixelRatio) / settings.area.width,
        (PREVIEW_MAX_HEIGHT * pixelRatio) / settings.area.height,
      )
      canvas.width = Math.max(1, Math.round(settings.area.width * scale))
      canvas.height = Math.max(1, Math.round(settings.area.height * scale))
      const context = canvas.getContext('2d')
      if (context) drawCrop(context, image, settings, scale)
    })
    return () => cancelAnimationFrame(frame)
  }, [image, settings])

  // Called by react-easy-crop for every crop, zoom or rotation change; the
  // area is in source-image pixels.
  function handleCropAreaChange(_area: Area, areaPixels: Area) {
    setSettings({ area: areaPixels, rotation })
  }

  function handleCancelEvent(event: SyntheticEvent<HTMLDialogElement>) {
    // Esc: let React decide, so the dialog only closes by unmounting.
    event.preventDefault()
    if (!isApplying) onCancel()
  }

  function changeZoom(next: number) {
    // Never store NaN: react-easy-crop compares zoom with !== on every
    // update, so NaN would make it recompute forever.
    if (!Number.isFinite(next)) return
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(2)))))
  }

  function resetCrop() {
    setCrop({ x: 0, y: 0 })
    setZoom(MIN_ZOOM)
    setRotation(0)
    setError(null)
  }

  async function apply() {
    if (!settings || !image || isApplying) return
    setIsApplying(true)
    setError(null)
    const message = await onApply(settings, image)
    // On success the parent closes (unmounts) this dialog.
    if (message) {
      setError(message)
      setIsApplying(false)
    }
  }

  const outputSize = settings
    ? `${Math.round(settings.area.width)} × ${Math.round(settings.area.height)} px`
    : null

  return (
    <dialog
      ref={dialogRef}
      className="crop-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={handleCancelEvent}
    >
      <div className="crop-dialog__header">
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId} className="muted">
          Drag the image so the card fills the frame. When the frame is
          focused, the arrow keys move it.
        </p>
      </div>

      <div className="crop-dialog__body">
        <div className="crop-dialog__cropper">
          {isOpen && (
            <Cropper
              image={imageUrl}
              crop={crop}
              zoom={zoom}
              rotation={rotation}
              aspect={CARD_ASPECT_RATIO}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              initialCroppedAreaPixels={initialSettings?.area}
              onCropChange={setCrop}
              onZoomChange={changeZoom}
              onRotationChange={(next) => setRotation(normalizeRotation(next))}
              onCropAreaChange={handleCropAreaChange}
              cropperProps={{
                'aria-label': 'Crop frame. Use the arrow keys to move it.',
              }}
              mediaProps={{ alt: '' }}
            />
          )}
        </div>

        <fieldset className="crop-dialog__controls" disabled={isApplying}>
          <legend className="visually-hidden">Crop settings</legend>

          <div className="crop-control">
            <div className="crop-control__row">
              <label htmlFor={zoomId}>Zoom</label>
              <output htmlFor={zoomId}>{Math.round(zoom * 100)}%</output>
            </div>
            <div className="crop-control__input">
              <button
                type="button"
                className="icon-button"
                aria-label="Zoom out"
                onClick={() => changeZoom(zoom - ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
              >
                <ZoomOut aria-hidden="true" size={18} />
              </button>
              <input
                ref={zoomInputRef}
                id={zoomId}
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                aria-valuetext={`${Math.round(zoom * 100)}%`}
                onChange={(event) => changeZoom(Number(event.target.value))}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Zoom in"
                onClick={() => changeZoom(zoom + ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
              >
                <ZoomIn aria-hidden="true" size={18} />
              </button>
            </div>
          </div>

          <div className="crop-control">
            <div className="crop-control__row">
              <label htmlFor={rotationId}>Rotation</label>
              <output htmlFor={rotationId}>{rotation}°</output>
            </div>
            <div className="crop-control__input">
              <button
                type="button"
                className="icon-button"
                aria-label="Rotate left 90 degrees"
                onClick={() => setRotation(normalizeRotation(rotation - 90))}
              >
                <RotateCcw aria-hidden="true" size={18} />
              </button>
              <input
                id={rotationId}
                type="range"
                min={-180}
                max={180}
                step={1}
                value={rotation}
                aria-valuetext={`${rotation} degrees`}
                onChange={(event) => setRotation(Number(event.target.value))}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Rotate right 90 degrees"
                onClick={() => setRotation(normalizeRotation(rotation + 90))}
              >
                <RotateCw aria-hidden="true" size={18} />
              </button>
            </div>
          </div>

          <button type="button" className="button button--secondary" onClick={resetCrop}>
            <Undo2 aria-hidden="true" size={16} />
            Reset crop
          </button>

          <figure className="crop-preview">
            <canvas
              ref={previewRef}
              className="crop-preview__canvas"
              role="img"
              aria-label="Preview of the cropped image"
            />
            <figcaption className="muted">
              Preview{outputSize ? ` · output ${outputSize}` : ''}
            </figcaption>
          </figure>
        </fieldset>
      </div>

      {error && (
        <p className="field-error crop-dialog__error" role="alert">
          <AlertCircle aria-hidden="true" size={16} />
          {error}
        </p>
      )}

      <div className="crop-dialog__footer">
        <button
          type="button"
          className="button button--secondary"
          onClick={onCancel}
          disabled={isApplying}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={apply}
          disabled={!settings || !image || isApplying}
        >
          {isApplying ? (
            <Loader2 aria-hidden="true" size={18} className="spin" />
          ) : (
            <Check aria-hidden="true" size={18} />
          )}
          {isApplying ? 'Applying…' : 'Apply crop'}
        </button>
      </div>
    </dialog>
  )
}
