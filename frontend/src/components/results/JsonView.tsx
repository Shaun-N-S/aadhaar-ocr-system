import { useMemo, useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import type { AadhaarDetails } from '../types/ocr.types'

type CopyState = 'idle' | 'copied' | 'failed'

// Shows the extracted Aadhaar details (the response's data.aadhaar object)
// exactly as the API returned them, formatted with two-space indentation;
// unread fields stay null. The Aadhaar number is already masked by the
// server; nothing here unmasks or adds to it.
export function JsonView({ details }: { details: AadhaarDetails }) {
  const json = useMemo(() => JSON.stringify(details, null, 2), [details])
  const [copyState, setCopyState] = useState<CopyState>('idle')

  async function copyJson() {
    try {
      // Unavailable outside secure contexts (HTTPS or localhost).
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(json)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className="json-view">
      <div className="json-view__toolbar">
        <p className="muted">
          The extracted Aadhaar details. They are personal data; paste them
          only somewhere you trust.
        </p>
        <button
          type="button"
          className="button button--secondary"
          onClick={copyJson}
        >
          {copyState === 'copied' ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Copy aria-hidden="true" size={16} />
          )}
          Copy JSON
        </button>
      </div>

      <p className="json-view__status" role="status">
        {copyState === 'copied' ? 'JSON copied to the clipboard.' : ''}
      </p>
      {copyState === 'failed' && (
        <p className="field-error" role="alert">
          <AlertCircle aria-hidden="true" size={16} />
          Couldn't copy to the clipboard (it may be blocked by the browser).
          Select the JSON below and copy it manually.
        </p>
      )}

      <pre
        className="json-view__code"
        tabIndex={0}
        aria-label="Extracted Aadhaar details as JSON"
      >
        <code>{json}</code>
      </pre>
    </div>
  )
}
