import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Braces, CheckCircle2, Info, ListChecks } from 'lucide-react'
import type { AadhaarDetails, OcrSuccessResponse } from '../types/ocr.types'
import { JsonView } from './JsonView'

const VIEWS = [
  { id: 'extracted', label: 'Extracted Data', Icon: ListChecks },
  { id: 'json', label: 'JSON View', Icon: Braces },
] as const
type View = (typeof VIEWS)[number]['id']

// Below this, Tesseract usually misreads a noticeable share of characters.
const LOW_CONFIDENCE = 60

const FIELDS: { key: keyof AadhaarDetails; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'dateOfBirth', label: 'Date of birth' },
  { key: 'yearOfBirth', label: 'Year of birth' },
  { key: 'gender', label: 'Gender' },
  { key: 'maskedAadhaarNumber', label: 'Aadhaar number' },
  { key: 'address', label: 'Address' },
  { key: 'pincode', label: 'PIN code' },
]

function ConfidenceMeter({ label, value }: { label: string; value: number | null }) {
  const id = `confidence-${label.toLowerCase()}`
  if (value === null) {
    return (
      <div className="confidence">
        <div className="confidence__row">
          <span>{label} image</span>
          <span className="muted">No fields read from this image</span>
        </div>
      </div>
    )
  }
  return (
    <div className="confidence">
      <div className="confidence__row">
        <label htmlFor={id}>{label} image</label>
        <span>{value}</span>
      </div>
      <meter
        id={id}
        min={0}
        max={100}
        low={LOW_CONFIDENCE}
        high={80}
        optimum={100}
        value={value}
      />
    </div>
  )
}

const isLow = (value: number | null) => value !== null && value < LOW_CONFIDENCE

export function OcrResults({ response }: { response: OcrSuccessResponse }) {
  const { aadhaar, ocrConfidence } = response.data
  const missingCount = FIELDS.filter(({ key }) => aadhaar[key] === null).length
  const hasLowConfidence = isLow(ocrConfidence.front) || isLow(ocrConfidence.back)

  const [view, setView] = useState<View>('extracted')
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({})
  const baseId = useId()
  const tabId = (id: View) => `${baseId}-tab-${id}`
  const panelId = (id: View) => `${baseId}-panel-${id}`

  // Tabs pattern: arrow keys, Home and End move between tabs.
  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = VIEWS.findIndex(({ id }) => id === view)
    const last = VIEWS.length - 1
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    const id = VIEWS[next]!.id
    setView(id)
    tabRefs.current[id]?.focus()
  }

  return (
    <section className="card results" aria-labelledby="results-heading">
      <div className="results__header">
        <CheckCircle2 aria-hidden="true" size={22} />
        <h2 id="results-heading">Extracted details</h2>
      </div>

      <div className="view-tabs" role="tablist" aria-label="Result view">
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[id] = element
            }}
            id={tabId(id)}
            type="button"
            role="tab"
            className="view-tabs__tab"
            aria-selected={view === id}
            aria-controls={panelId(id)}
            tabIndex={view === id ? 0 : -1}
            onClick={() => setView(id)}
            onKeyDown={handleTabKeyDown}
          >
            <Icon aria-hidden="true" size={16} />
            {label}
          </button>
        ))}
      </div>

      <div
        id={panelId('extracted')}
        className="results__panel"
        role="tabpanel"
        aria-labelledby={tabId('extracted')}
        tabIndex={0}
        hidden={view !== 'extracted'}
      >
        <dl className="results__fields">
          {FIELDS.map(({ key, label }) => {
            const value = aadhaar[key]
            return (
              <div className="results__field" key={key}>
                <dt>{label}</dt>
                <dd className={value === null ? 'results__missing' : undefined}>
                  {value === null ? 'Not detected' : value}
                </dd>
              </div>
            )
          })}
        </dl>

        <div className="results__confidence">
          <h3>Text recognition confidence</h3>
          <ConfidenceMeter label="Front" value={ocrConfidence.front} />
          <ConfidenceMeter label="Back" value={ocrConfidence.back} />
          <p className="muted">
            The OCR engine's score (0–100) for the words these fields were read
            from. It shows how clearly that text was recognized; it is not the
            probability that a field is correct.
          </p>
        </div>

        {(missingCount > 0 || hasLowConfidence) && (
          <div className="alert alert--info">
            <Info aria-hidden="true" size={20} />
            <p className="alert__message">
              {missingCount > 0 &&
                `${missingCount} field${missingCount === 1 ? ' was' : 's were'} not detected. `}
              {hasLowConfidence && 'Some text was hard to read. '}
              A sharper, well-lit photo taken straight on usually gives better
              results.
            </p>
          </div>
        )}

        <p className="muted">
          OCR can misread text. Always check these details against the card.
        </p>
      </div>

      <div
        id={panelId('json')}
        role="tabpanel"
        aria-labelledby={tabId('json')}
        hidden={view !== 'json'}
      >
        {view === 'json' && <JsonView details={aadhaar} />}
      </div>
    </section>
  )
}
