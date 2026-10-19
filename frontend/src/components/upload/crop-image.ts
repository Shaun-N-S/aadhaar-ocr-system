// Turns a crop chosen in react-easy-crop into a real image file.

/** A rectangle in source-image pixels, as reported by react-easy-crop. */
export interface PixelArea {
  x: number
  y: number
  width: number
  height: number
}

export interface CropSettings {
  area: PixelArea
  /** Degrees, clockwise. */
  rotation: number
}

// ID-1 card size (85.6 x 54 mm), used by Aadhaar PVC cards.
export const CARD_ASPECT_RATIO = 85.6 / 54

// JPEG quality for cropped output: high, so OCR keeps fine print detail.
const JPEG_QUALITY = 0.95

// Some browsers (notably iOS Safari) cannot allocate canvases larger than
// about 16.7 megapixels. Output is only scaled down to this if a full-size
// canvas actually fails.
const SAFE_CANVAS_PIXELS = 4096 * 4096

// Small crops are enlarged (same region, same aspect ratio) so their longer
// side is at least this many pixels: on small photos the text is too small
// for OCR to read reliably. In testing, 1200 px improved results without
// losing any field that native size read; larger targets did lose fields.
// Even a worst-case (random noise) 1200 x 1200 PNG stays under the 5 MB
// upload limit (about 4.6 MB).
const MIN_OUTPUT_LONG_SIDE = 1200

export function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  return image.decode().then(() => image)
}

/** Size of the box that contains the image after rotating it. */
function rotatedSize(width: number, height: number, rotation: number) {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return { width: width * cos + height * sin, height: width * sin + height * cos }
}

/**
 * Draws the cropped, rotated region of `image` onto `context`, scaled by
 * `scale`. react-easy-crop measures `area` within the bounding box of the
 * rotated image, so the image is rotated about that box's centre first.
 */
export function drawCrop(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  { area, rotation }: CropSettings,
  scale = 1,
): void {
  const { naturalWidth: width, naturalHeight: height } = image
  const box = rotatedSize(width, height, rotation)

  context.save()
  // Areas outside the rotated image would otherwise be transparent (black in
  // JPEG); white is neutral for OCR.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, context.canvas.width, context.canvas.height)
  context.imageSmoothingQuality = 'high'
  context.scale(scale, scale)
  context.translate(-area.x, -area.y)
  context.translate(box.width / 2, box.height / 2)
  context.rotate((rotation * Math.PI) / 180)
  context.drawImage(image, -width / 2, -height / 2)
  context.restore()
}

function renderToBlob(
  image: HTMLImageElement,
  settings: CropSettings,
  type: string,
  scale: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(settings.area.width * scale))
  canvas.height = Math.max(1, Math.round(settings.area.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)

  drawCrop(context, image, settings, scale)
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        // Release the canvas memory straight away.
        canvas.width = 0
        canvas.height = 0
        resolve(blob)
      },
      type,
      JPEG_QUALITY,
    )
  })
}

function croppedFileName(originalName: string, type: string): string {
  const base = originalName.replace(/\.[^.]*$/, '') || 'image'
  return `${base}-cropped${type === 'image/png' ? '.png' : '.jpg'}`
}

/**
 * Creates the cropped image at the source's full resolution (enlarged if the
 * crop is small), in the same format as the source (PNG stays PNG, JPEG
 * stays JPEG). The output carries no EXIF metadata; any EXIF rotation is
 * already applied by the browser.
 */
export async function createCroppedFile(
  source: File,
  image: HTMLImageElement,
  settings: CropSettings,
): Promise<File> {
  const type = source.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const pixels = settings.area.width * settings.area.height
  const longSide = Math.max(settings.area.width, settings.area.height)
  const upscale = Math.max(1, MIN_OUTPUT_LONG_SIDE / longSide)

  let blob = await renderToBlob(image, settings, type, upscale)
  if (!blob && pixels > SAFE_CANVAS_PIXELS) {
    blob = await renderToBlob(image, settings, type, Math.sqrt(SAFE_CANVAS_PIXELS / pixels))
  }
  if (!blob) {
    throw new Error('Could not create the cropped image')
  }

  return new File([blob], croppedFileName(source.name, type), {
    type,
    lastModified: Date.now(),
  })
}
