import { AlertTriangle, Clock, FileWarning, WifiOff } from 'lucide-react'
import type { UserError } from '../types/ocr.types'

const ICONS = {
  validation: FileWarning,
  unreadable: FileWarning,
  'not-aadhaar': FileWarning,
  busy: Clock,
  network: WifiOff,
  server: AlertTriangle,
} as const

export function ErrorAlert({ error }: { error: UserError }) {
  const Icon = ICONS[error.kind]
  return (
    <div className="alert alert--error" role="alert">
      <Icon aria-hidden="true" size={20} />
      <div>
        <p className="alert__title">{error.title}</p>
        <p className="alert__message">{error.message}</p>
      </div>
    </div>
  )
}
