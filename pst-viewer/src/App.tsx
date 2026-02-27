import { Component, useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { usePSTWorker, bodyKey } from './usePSTWorker.ts'
import { VirtualEmailList } from './VirtualEmailList.tsx'
import type { FolderNode, EmailMeta, ExportOptions } from './types.ts'

// ─── Error Boundary ──────────────────────────────────────────────────────────

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50 p-8">
          <div className="text-center max-w-lg">
            <div className="text-5xl mb-4">&#9888;</div>
            <h1 className="text-xl font-bold text-gray-800 mb-2">Ein unerwarteter Fehler ist aufgetreten</h1>
            <p className="text-gray-500 mb-4 font-mono text-sm break-all">{this.state.error.message}</p>
            <button
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
              onClick={() => this.setState({ error: null })}
            >
              Erneut versuchen
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const MIN_SIDEBAR = 180
const MAX_SIDEBAR = 500
const MIN_LIST = 280
const MAX_LIST = 800

// ─── ResizeHandle ────────────────────────────────────────────────────────────

function ResizeHandle({ onDrag }: { onDrag: (delta: number) => void }) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    let lastX = e.clientX
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (me: MouseEvent) => {
      const delta = me.clientX - lastX
      lastX = me.clientX
      onDrag(delta)
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onDrag])

  return (
    <div
      className="w-1 flex-shrink-0 bg-gray-200 hover:bg-blue-400 cursor-col-resize transition-colors"
      onMouseDown={onMouseDown}
    />
  )
}

// ─── UI components ───────────────────────────────────────────────────────────

function FolderTreeItem({
  folder, selectedPath, onSelect, depth = 0,
}: {
  folder: FolderNode; selectedPath: string; onSelect: (folder: FolderNode) => void; depth?: number
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const isSelected = selectedPath === folder.path
  const hasChildren = folder.children.length > 0
  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 cursor-pointer rounded text-sm hover:bg-blue-50 ${
          isSelected ? 'bg-blue-100 font-semibold text-blue-900' : 'text-gray-700'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(folder)}
      >
        {hasChildren ? (
          <button
            className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 flex-shrink-0"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <span className="truncate">{folder.name}</span>
        {folder.emailCount > 0 && (
          <span className="text-xs text-gray-400 ml-auto flex-shrink-0">{folder.emailCount}</span>
        )}
      </div>
      {expanded && folder.children.map((child, i) => (
        <FolderTreeItem key={i} folder={child} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
      ))}
    </div>
  )
}

// ─── Export dialog (shared between search and folder export) ─────────────────

const EXPORT_WARN_THRESHOLD = 1000
const EXPORT_WARN_ATTACHMENTS = 500

function ExportDialog({
  count,
  label,
  options,
  onOptionsChange,
  onExport,
  exporting,
  loadingMsg,
  attachmentCount,
}: {
  count: number
  label: string
  options: ExportOptions
  onOptionsChange: (options: ExportOptions) => void
  onExport: () => void
  exporting: boolean
  loadingMsg: string
  /** Total number of emails with attachments in the export set (for warning) */
  attachmentCount?: number
}) {
  const [showDialog, setShowDialog] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  const needsWarning = count >= EXPORT_WARN_THRESHOLD
    || (options.includeAttachments && (attachmentCount ?? 0) >= EXPORT_WARN_ATTACHMENTS)

  useEffect(() => {
    if (!showDialog) return
    setConfirmed(false)
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) setShowDialog(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDialog])

  return (
    <div className="relative" ref={dialogRef}>
      <button
        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        onClick={() => setShowDialog(!showDialog)}
        disabled={exporting}
      >
        {exporting ? (
          <>
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {loadingMsg || 'Exportiert...'}
          </>
        ) : 'Exportieren'}
      </button>
      {showDialog && !exporting && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg shadow-xl border border-gray-200 p-3 z-50">
          <div className="text-xs font-semibold text-gray-600 mb-2">Export-Optionen</div>
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeHTML}
              onChange={(e) => onOptionsChange({ ...options, includeHTML: e.target.checked })}
              className="rounded"
            />
            HTML-Inhalt
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeTXT}
              onChange={(e) => onOptionsChange({ ...options, includeTXT: e.target.checked })}
              className="rounded"
            />
            Textinhalt
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeAttachments}
              onChange={(e) => onOptionsChange({ ...options, includeAttachments: e.target.checked })}
              className="rounded"
            />
            Anh&auml;nge einschlie&szlig;en
          </label>
          {needsWarning && !confirmed && (
            <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              <div className="font-semibold mb-1">Grosser Export</div>
              <p>
                {count >= EXPORT_WARN_THRESHOLD && `${count.toLocaleString('de-DE')} E-Mails`}
                {count >= EXPORT_WARN_THRESHOLD && options.includeAttachments && (attachmentCount ?? 0) >= EXPORT_WARN_ATTACHMENTS && ' mit '}
                {options.includeAttachments && (attachmentCount ?? 0) >= EXPORT_WARN_ATTACHMENTS && `${(attachmentCount ?? 0).toLocaleString('de-DE')} Anh&auml;ngen`}
                {' '}k&ouml;nnen viel Arbeitsspeicher beanspruchen und den Browser verlangsamen.
              </p>
              <button
                className="mt-1.5 px-2 py-0.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 transition"
                onClick={() => setConfirmed(true)}
              >
                Trotzdem exportieren
              </button>
            </div>
          )}
          <button
            className="w-full px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50"
            onClick={() => { onExport(); setShowDialog(false) }}
            disabled={(!options.includeHTML && !options.includeTXT) || (needsWarning && !confirmed)}
          >
            {count.toLocaleString('de-DE')} {label} als ZIP exportieren
          </button>
          {!options.includeHTML && !options.includeTXT && (
            <div className="text-xs text-red-500 mt-1">Mindestens ein Inhaltsformat w&auml;hlen</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Help dialog ─────────────────────────────────────────────────────────────

function HelpDialog({ onClose }: { onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto relative">
        <button
          className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
          onClick={onClose}
        >
          &#10005;
        </button>

        <div className="p-6">
          <h1 className="text-xl font-bold text-gray-900 mb-6">PST Viewer — Hilfe</h1>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Erste Schritte</h2>
            <p className="text-sm text-gray-600">
              Outlook PST-Dateien k&ouml;nnen auf drei Wegen ge&ouml;ffnet werden:
              per <b>Drag &amp; Drop</b> auf das Fenster, &uuml;ber das <b>Datei</b>-Men&uuml; oder mit dem Tastenkuerzel <b>Strg+O</b>.
              Die Datei wird vollst&auml;ndig lokal im Browser verarbeitet.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Ordnerstruktur</h2>
            <p className="text-sm text-gray-600">
              Nach dem &Ouml;ffnen wird die Ordnerstruktur der PST-Datei links angezeigt.
              Der erste Ordner mit E-Mails wird automatisch ausgew&auml;hlt.
              Ordner k&ouml;nnen auf-/zugeklappt werden. Die Zahl neben dem Ordnernamen zeigt die Anzahl der enthaltenen E-Mails.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">E-Mails lesen</h2>
            <p className="text-sm text-gray-600">
              Klicken Sie auf einen Ordner, um dessen E-Mails zu laden. Bei grossen Ordnern (500+ Nachrichten) werden die E-Mails seitenweise geladen —
              die ersten 50 erscheinen sofort, der Rest streamt im Hintergrund nach.
              Klicken Sie auf eine E-Mail, um deren Inhalt anzuzeigen. HTML-E-Mails werden formatiert dargestellt, reine Text-E-Mails als Klartext.
              Anh&auml;nge werden unter den E-Mail-Details aufgelistet.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Termine, Aufgaben &amp; Kontakte</h2>
            <p className="text-sm text-gray-600">
              PST-Dateien k&ouml;nnen neben E-Mails auch <b>Kalendereintr&auml;ge</b>, <b>Aufgaben</b>, <b>Kontakte</b> und <b>Journal-Eintr&auml;ge</b> enthalten.
              Diese werden automatisch erkannt und mit farbigen Badges in der Liste gekennzeichnet.
              In der Kurzvorschau erscheinen typ-spezifische Informationen statt des Nachrichtentexts:
              Uhrzeit und Ort bei Terminen, Status und Fortschritt bei Aufgaben, Firma und Telefonnummer bei Kontakten.
            </p>
            <p className="text-sm text-gray-600 mt-1">
              Die Detail-Ansicht zeigt je nach Typ passende Felder:
              Beginn/Ende, Dauer, Ort und Teilnehmer bei Terminen;
              Status, Fortschritt, Besitzer und F&auml;lligkeitsdatum bei Aufgaben;
              Name, Firma, Position, E-Mail, Telefon und Adresse bei Kontakten.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Suche</h2>
            <p className="text-sm text-gray-600">
              Mit <b>Strg+F</b> oder Klick auf das Suchfeld k&ouml;nnen Sie nach E-Mails und anderen Elementen suchen.
              Die Suche arbeitet im aktuell ausgew&auml;hlten Ordner und durchsucht Betreff, Absender, Empf&auml;nger, Anh&auml;nge sowie typ-spezifische Felder (Ort bei Terminen, Besitzer bei Aufgaben, Name/Firma/E-Mail bei Kontakten).
              Optional kann auch der Nachrichtentext durchsucht werden (&bdquo;Auch Inhalt durchsuchen&ldquo;).
              Mehrere Suchbegriffe werden mit UND verkn&uuml;pft. Die Suche ist nicht Gross-/Kleinschreibung-sensitiv.
              Bei grossen Ordnern werden Treffer und Fortschritt schrittweise angezeigt; die Suche kann jederzeit abgebrochen werden.
              Treffer k&ouml;nnen bereits w&auml;hrend der laufenden Suche ge&ouml;ffnet und gelesen werden.
              Bestimmte Detail-Aktionen (z.B. Teilen/Anhang laden) sind bis zum Ende der Suche kurzzeitig gesperrt.
              Mit <b>Escape</b> wird die Suche geschlossen.
            </p>
            <p className="text-sm text-gray-600 mt-2">
              <b>Hintergrund-Indizierung:</b> Nach dem &Ouml;ffnen einer PST-Datei werden alle Ordner automatisch im Hintergrund indiziert.
              Der Fortschritt wird in der Titelleiste angezeigt.
              Sobald die Indizierung abgeschlossen ist, sind Header-Suchen (ohne Inhalt) in allen Ordnern quasi-instant — auch in bisher nicht besuchten.
              Die Indizierung pausiert automatisch, wenn Sie Ordner wechseln oder suchen.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">EML-Export</h2>
            <p className="text-sm text-gray-600">
              Suchergebnisse oder ganze Ordner k&ouml;nnen als ZIP-Archiv mit EML-Dateien exportiert werden.
              Klicken Sie auf den <b>Exportieren</b>-Button im Such- oder Ordner-Header.
              Im Export-Dialog k&ouml;nnen Sie w&auml;hlen, ob HTML-Inhalt, Textinhalt und/oder Anh&auml;nge eingeschlossen werden sollen.
              Die EML-Dateien sind MIME-konform und k&ouml;nnen in jedem E-Mail-Programm ge&ouml;ffnet werden.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">OPFS-Cache</h2>
            <p className="text-sm text-gray-600">
              Grosse PST-Dateien werden automatisch im lokalen OPFS-Cache (Origin Private File System) gespeichert.
              Beim n&auml;chsten Besuch wird die Datei aus dem Cache geladen, ohne sie erneut ausw&auml;hlen zu m&uuml;ssen.
              Der Cache kann &uuml;ber <b>Datei &rarr; PST schliessen &amp; Cache l&ouml;schen</b> gel&ouml;scht werden.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Tastenkuerzel</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="pb-1 pr-4 font-medium">Taste</th>
                  <th className="pb-1 font-medium">Funktion</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr><td className="py-1 pr-4 font-mono text-xs">Strg+O</td><td>PST-Datei &ouml;ffnen</td></tr>
                <tr><td className="py-1 pr-4 font-mono text-xs">Strg+F</td><td>Suche &ouml;ffnen</td></tr>
                <tr><td className="py-1 pr-4 font-mono text-xs">Strg+B</td><td>Ordnerleiste ein-/ausblenden</td></tr>
                <tr><td className="py-1 pr-4 font-mono text-xs">Escape</td><td>Suche schliessen / Hilfe schliessen</td></tr>
                <tr><td className="py-1 pr-4 font-mono text-xs">F1</td><td>Hilfe anzeigen</td></tr>
              </tbody>
            </table>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Browser-Kompatibilit&auml;t</h2>
            <p className="text-sm text-gray-600">
              <b>Chrome</b> und <b>Edge</b> (ab Version 102) werden empfohlen — sie unterst&uuml;tzen OPFS f&uuml;r grosse Dateien (&gt;250 MB).
              Firefox und Safari funktionieren f&uuml;r kleinere PST-Dateien.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-800 mb-1">Datenschutz</h2>
            <p className="text-sm text-gray-600">
              Alle Daten werden ausschliesslich lokal im Browser verarbeitet. Es werden keine Daten an einen Server &uuml;bertragen.
              Die PST-Datei verlässt Ihren Computer nicht. Der OPFS-Cache ist nur f&uuml;r diese Webseite zugänglich.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

// ─── Info / About dialog ─────────────────────────────────────────────────────

const LIB_CREDITS: Array<{ name: string; version: string; author: string; license: string; url: string }> = [
  { name: 'React', version: '19.2', author: 'Meta / Facebook', license: 'MIT', url: 'https://github.com/facebook/react/blob/main/LICENSE' },
  { name: 'TypeScript', version: '5.9', author: 'Microsoft', license: 'Apache-2.0', url: 'https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt' },
  { name: 'Vite', version: '7.3', author: 'Evan You', license: 'MIT', url: 'https://github.com/vitejs/vite/blob/main/LICENSE' },
  { name: 'Tailwind CSS', version: '4.2', author: 'Tailwind Labs', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE' },
  { name: 'vite-plugin-singlefile', version: '2.3', author: 'Richard Tallent', license: 'MIT', url: 'https://github.com/nicksrandall/vite-plugin-singlefile/blob/main/LICENSE' },
  { name: 'pst-extractor', version: '1.12', author: 'Ed Pfromer', license: 'MIT', url: 'https://github.com/nicksrandall/pst-extractor/blob/main/LICENSE' },
  { name: '@tanstack/react-virtual', version: '3.13', author: 'Tanner Linsley', license: 'MIT', url: 'https://github.com/TanStack/virtual/blob/main/LICENSE' },
  { name: 'fflate', version: '0.8', author: 'Arjun Barrett', license: 'MIT', url: 'https://github.com/101arrowz/fflate/blob/master/LICENSE' },
  { name: 'buffer', version: '6.0', author: 'Feross Aboukhadijeh', license: 'MIT', url: 'https://github.com/nicksrandall/feross/buffer/blob/master/LICENSE' },
]

function InfoDialog({ onClose }: { onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full max-h-[80vh] overflow-y-auto relative">
        <button
          className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
          onClick={onClose}
        >
          &#10005;
        </button>

        <div className="p-6">
          <div className="text-center mb-6">
            <div className="text-4xl mb-2">&#128231;</div>
            <h1 className="text-xl font-bold text-gray-900">PST Viewer</h1>
            <p className="text-sm text-gray-500 mt-1">Browser-basierter Outlook PST-Datei-Viewer</p>
            <p className="text-xs text-gray-400 mt-2">&copy; {new Date().getFullYear()} MEUSE24</p>
            <div className="flex items-center justify-center gap-3 mt-2">
              <a href="https://meuse24.info" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">meuse24.info</a>
              <span className="text-gray-300">|</span>
              <a href="https://github.com/meuse24/pst-viewer" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">GitHub</a>
            </div>
          </div>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-2">Tech Stack</h2>
            <div className="flex flex-wrap gap-1.5">
              {['React 19', 'TypeScript 5.9', 'Vite 7', 'Tailwind CSS 4', 'Web Workers', 'IndexedDB', 'OPFS'].map(tag => (
                <span key={tag} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">{tag}</span>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Einzelne HTML-Datei, kein Server, alle Daten lokal im Browser.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-2">Suchmodus</h2>
            <p className="text-sm text-gray-600">
              Die Suche l&auml;uft im jeweils ausgew&auml;hlten Ordner und durchsucht Betreff, Absender, Empf&auml;nger und Anh&auml;nge. Mit der Option &bdquo;Auch Inhalt durchsuchen&ldquo; wird zus&auml;tzlich der Nachrichtentext einbezogen.
              Treffer werden bei grossen Ordnern schrittweise geliefert, inklusive Fortschrittsanzeige und Abbrechen-Funktion.
              Treffer lassen sich bereits waehrend der Suche oeffnen.
              Teilen und Anhang-Download bleiben waehrenddessen kurzzeitig deaktiviert.
              Alle Ordner werden nach dem &Ouml;ffnen automatisch im Hintergrund indiziert — Header-Suchen sind danach in jedem Ordner sofort verf&uuml;gbar.
            </p>
          </section>

          <section className="mb-5">
            <h2 className="text-base font-semibold text-gray-800 mb-2">Verwendete Bibliotheken</h2>
            <p className="text-xs text-gray-500 mb-2">
              Vielen Dank an die Autoren und Maintainer folgender Open-Source-Bibliotheken:
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="pb-1 pr-2 font-medium">Bibliothek</th>
                  <th className="pb-1 pr-2 font-medium">Version</th>
                  <th className="pb-1 pr-2 font-medium">Autor</th>
                  <th className="pb-1 font-medium">Lizenz</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                {LIB_CREDITS.map(lib => (
                  <tr key={lib.name} className="border-b border-gray-50">
                    <td className="py-1 pr-2 font-medium text-gray-700">{lib.name}</td>
                    <td className="py-1 pr-2">{lib.version}</td>
                    <td className="py-1 pr-2">{lib.author}</td>
                    <td className="py-1">
                      <a href={lib.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {lib.license}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-800 mb-2">Entwicklungswerkzeuge</h2>
            <p className="text-sm text-gray-600">
              Dieses Projekt wurde mit Unterst&uuml;tzung von{' '}
              <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Claude Code</a>
              {' '}(Anthropic) und{' '}
              <a href="https://openai.com/codex" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Codex CLI</a>
              {' '}(OpenAI) entwickelt. Vielen Dank an beide Teams f&uuml;r ihre herausragenden AI-Coding-Werkzeuge.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

// ─── Sort button ────────────────────────────────────────────────────────────

const SORT_OPTIONS: Array<{ key: 'date' | 'subject' | 'senderName' | 'numberOfAttachments'; label: string; defaultDir: 'asc' | 'desc' }> = [
  { key: 'date', label: 'Datum', defaultDir: 'desc' },
  { key: 'subject', label: 'Betreff', defaultDir: 'asc' },
  { key: 'senderName', label: 'Absender', defaultDir: 'asc' },
  { key: 'numberOfAttachments', label: 'Anhänge', defaultDir: 'desc' },
]

function SortButton({
  field, direction, onSort,
}: {
  field: 'date' | 'subject' | 'senderName' | 'numberOfAttachments'; direction: 'asc' | 'desc'
  onSort: (field: 'date' | 'subject' | 'senderName' | 'numberOfAttachments', direction: 'asc' | 'desc') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler) }
  }, [open])

  const activeLabel = SORT_OPTIONS.find(o => o.key === field)?.label ?? field
  const arrow = direction === 'asc' ? '\u2191' : '\u2193'

  return (
    <div className="relative" ref={ref}>
      <button
        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded flex items-center gap-1 hover:bg-gray-50 transition"
        onClick={() => setOpen(!open)}
        title="Sortierung ändern"
      >
        {arrow} {activeLabel}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
          {SORT_OPTIONS.map(opt => {
            const isActive = field === opt.key
            return (
              <button
                key={opt.key}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${isActive ? 'text-blue-700 bg-blue-50' : 'text-gray-700 hover:bg-gray-50'}`}
                onClick={() => {
                  if (isActive) {
                    onSort(opt.key, direction === 'asc' ? 'desc' : 'asc')
                  } else {
                    onSort(opt.key, opt.defaultDir)
                  }
                  setOpen(false)
                }}
              >
                {isActive && <span className="text-blue-600">{arrow}</span>}
                {!isActive && <span className="w-3" />}
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Menu dropdown ───────────────────────────────────────────────────────────

function MenuBar({
  fileName,
  fileSize,
  savedAt,
  onOpenFile,
  onCloseFile,
  onShowHelp,
  onShowInfo,
  sidebarVisible,
  onToggleSidebar,
  loading,
  indexProgress,
}: {
  fileName: string
  fileSize: number
  savedAt: number
  onOpenFile: (file: File) => void
  onCloseFile: () => void
  onShowHelp: () => void
  onShowInfo: () => void
  sidebarVisible: boolean
  onToggleSidebar: () => void
  loading: boolean
  indexProgress: { indexed: number; total: number } | null
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  return (
    <div className="h-9 bg-gray-800 flex items-center px-2 gap-3 flex-shrink-0" ref={menuRef}>
      <button
        className="px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 hover:text-white rounded transition"
        onClick={onToggleSidebar}
        title={sidebarVisible ? 'Ordnerleiste ausblenden (Strg+B)' : 'Ordnerleiste einblenden (Strg+B)'}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div className="relative">
        <button
          className={`px-3 py-1 text-sm rounded transition ${
            open ? 'bg-gray-600 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'
          }`}
          onClick={() => setOpen(!open)}
        >
          Datei
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
            <button
              className={`w-full text-left px-4 py-2 text-sm flex items-center gap-3 ${loading ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'}`}
              disabled={loading}
              onClick={() => {
                fileInputRef.current?.click()
                setOpen(false)
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
              PST-Datei &ouml;ffnen...
              <span className="ml-auto text-xs text-gray-400">Strg+O</span>
            </button>
            {fileName && (
              <>
                <div className="border-t border-gray-100 my-1" />
                <div className="px-4 py-2 text-xs text-gray-400">
                  <div className="font-medium text-gray-600 truncate">{fileName}</div>
                  <div>{formatFileSize(fileSize)}</div>
                  {savedAt > 0 && (
                    <div>Gespeichert: {new Date(savedAt).toLocaleString('de-DE')}</div>
                  )}
                </div>
                <div className="border-t border-gray-100 my-1" />
                <button
                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-3"
                  onClick={() => { onCloseFile(); setOpen(false) }}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  PST schlie&szlig;en &amp; Cache l&ouml;schen
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <button
        className="px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 hover:text-white rounded transition"
        onClick={onShowHelp}
      >
        Hilfe
      </button>

      <button
        className="px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 hover:text-white rounded transition"
        onClick={onShowInfo}
      >
        Info
      </button>

      {fileName && (
        <span className="text-xs text-gray-400 truncate">
          {fileName} ({formatFileSize(fileSize)})
          {indexProgress && indexProgress.indexed < indexProgress.total && (
            <span className="ml-2 text-gray-500">
              &middot; Indizierung: {indexProgress.indexed} / {indexProgress.total} Ordner
            </span>
          )}
          {indexProgress && indexProgress.indexed >= indexProgress.total && (
            <span className="ml-2 text-green-400">
              &middot; &#10003; {indexProgress.total} Ordner indiziert
            </span>
          )}
        </span>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".pst,.ost"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onOpenFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

function App() {
  const pst = usePSTWorker()
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null)
  const [selectedEmail, setSelectedEmail] = useState<EmailMeta | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchQueryRef = useRef(searchQuery)
  searchQueryRef.current = searchQuery
  const [searchIncludeBody, setSearchIncludeBody] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loadingRef = useRef(pst.loading)
  loadingRef.current = pst.loading

  const [exportOptions, setExportOptions] = useState<ExportOptions>({ includeHTML: true, includeTXT: true, includeAttachments: false })
  const [showSplash, setShowSplash] = useState(true)
  const [showHelp, setShowHelp] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [listWidth, setListWidth] = useState(384)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sortField, setSortField] = useState<'date' | 'subject' | 'senderName' | 'numberOfAttachments'>('date')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  const debouncedQuery = useDebounce(searchQuery, 200)
  const isSearching = debouncedQuery.trim().length > 0
  const abortSearch = pst.abortSearch

  // Find the selected folder node in the tree
  const selectedFolder = useMemo(() => {
    if (!pst.tree || !selectedFolderPath) return null
    const find = (node: FolderNode): FolderNode | null => {
      if (node.path === selectedFolderPath) return node
      for (const child of node.children) {
        const found = find(child)
        if (found) return found
      }
      return null
    }
    return find(pst.tree)
  }, [pst.tree, selectedFolderPath])

  // Auto-select first folder with emails when tree loads
  useEffect(() => {
    if (!pst.tree) {
      setSelectedFolderPath(null)
      setSelectedEmail(null)
      setSearchQuery('')
      return
    }
    const findFirst = (node: FolderNode): FolderNode | null => {
      if (node.emailCount > 0) return node
      for (const child of node.children) {
        const found = findFirst(child)
        if (found) return found
      }
      return null
    }
    const first = findFirst(pst.tree)
    if (first) {
      setSelectedFolderPath(first.path)
      pst.fetchFolder(first.path)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pst.tree])

  // Trigger search when debounced query changes
  useEffect(() => {
    if (!selectedFolderPath || !debouncedQuery.trim() || !searchQueryRef.current.trim()) {
      abortSearch()
      return
    }
    pst.search(debouncedQuery, selectedFolderPath, searchIncludeBody)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, selectedFolderPath, searchIncludeBody])

  // Get emails for current view
  const folderEmailList = selectedFolderPath ? pst.folderEmails.get(selectedFolderPath) : undefined
  const displayEmails = useMemo(() => isSearching
    ? (pst.searchResults || []).map(r => r.email)
    : folderEmailList || []
  , [isSearching, pst.searchResults, folderEmailList])

  // Sort emails — skip during folder pagination to avoid hundreds of redundant sorts on large folders
  const folderStillPaging = !isSearching && !!selectedFolderPath && pst.folderLoadingPaths.has(selectedFolderPath)
  const sortedPairs = useMemo(() => {
    if (folderStillPaging) return null
    const pairs = displayEmails.map((email, i) => ({ email, origIndex: i }))
    if (pairs.length <= 1) return pairs
    const dir = sortDirection === 'asc' ? 1 : -1
    return pairs.sort((a, b) => {
      switch (sortField) {
        case 'date': {
          if (!a.email.date && !b.email.date) return 0
          if (!a.email.date) return 1
          if (!b.email.date) return -1
          return a.email.date < b.email.date ? -dir : a.email.date > b.email.date ? dir : 0
        }
        case 'subject':
          return dir * a.email.subject.localeCompare(b.email.subject, 'de')
        case 'senderName': {
          const sa = a.email.senderName || a.email.senderEmail
          const sb = b.email.senderName || b.email.senderEmail
          return dir * sa.localeCompare(sb, 'de')
        }
        case 'numberOfAttachments':
          return dir * (a.email.numberOfAttachments - b.email.numberOfAttachments)
      }
    })
  }, [displayEmails, sortField, sortDirection, folderStillPaging])

  const sortedEmails = useMemo(() => sortedPairs ? sortedPairs.map(p => p.email) : displayEmails, [sortedPairs, displayEmails])
  const sortedSearchResults = useMemo(() => {
    if (!isSearching || !pst.searchResults) return pst.searchResults
    if (!sortedPairs) return pst.searchResults
    return sortedPairs.map(p => pst.searchResults![p.origIndex])
  }, [isSearching, pst.searchResults, sortedPairs])

  const handleSort = useCallback((field: 'date' | 'subject' | 'senderName' | 'numberOfAttachments', direction: 'asc' | 'desc') => {
    setSortField(field)
    setSortDirection(direction)
  }, [])

  // Fetch body when email is selected
  useEffect(() => {
    if (selectedEmail) {
      pst.fetchBody(selectedEmail.folderPath, selectedEmail.index)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail])

  const selectedBody = selectedEmail
    ? pst.bodyCache.get(bodyKey(selectedEmail.folderPath, selectedEmail.index))
    : null

  const searchTotal = (pst.searchProgress?.total && pst.searchProgress.total > 0)
    ? pst.searchProgress.total
    : (selectedFolder?.emailCount ?? 0)
  const searchScanned = pst.searchProgress?.scanned ?? 0
  const searchMatches = pst.searchProgress?.matches ?? pst.searchResults?.length ?? 0
  const searchPercent = searchTotal > 0 ? Math.min(100, Math.round((searchScanned / searchTotal) * 100)) : 0

  const handleFolderSelect = useCallback((folder: FolderNode) => {
    abortSearch()
    setSelectedFolderPath(folder.path)
    setSelectedEmail(null)
    setSearchQuery('')
    pst.fetchFolder(folder.path)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext !== 'pst' && ext !== 'ost') {
      alert('Bitte eine PST- oder OST-Datei auswählen.')
      return
    }
    abortSearch()
    setSelectedEmail(null)
    setSelectedFolderPath(null)
    setSearchQuery('')
    pst.loadFile(file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(() => {
    abortSearch()
    setSelectedEmail(null)
    setSelectedFolderPath(null)
    setSearchQuery('')
    pst.closeFile()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (loadingRef.current) return
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const handleEmailSelect = useCallback((email: EmailMeta) => {
    setSelectedEmail(email)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault()
        if (!loadingRef.current) fileInputRef.current?.click()
      }
      if (e.key === 'Escape' && isSearching) {
        abortSearch()
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
      if (e.key === 'F1') {
        e.preventDefault()
        setShowHelp(true)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarVisible(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isSearching, abortSearch])

  const handleSearchExport = useCallback(() => {
    if (!pst.searchResults || pst.searchResults.length === 0) return
    const emails = pst.searchResults.map(r => ({ folderPath: r.folderPath, index: r.email.index }))
    pst.exportEmails(emails, exportOptions)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pst.searchResults, exportOptions])

  const handleFolderExport = useCallback(() => {
    if (!selectedFolderPath) return
    pst.exportFolder(selectedFolderPath, exportOptions)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderPath, exportOptions])

  // ── Landing page ─────────────────────────────────────────────────────────────
  if (!pst.tree) {
    return (
      <div
        className="flex flex-col min-h-screen bg-gray-50"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <MenuBar
          fileName={pst.fileName}
          fileSize={pst.fileSize}
          savedAt={pst.savedAt}
          onOpenFile={handleFile}
          onCloseFile={handleClose}
          onShowHelp={() => setShowHelp(true)}
          onShowInfo={() => setShowInfo(true)}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible(v => !v)}
          loading={pst.loading}
          indexProgress={pst.indexProgress}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-12 border-2 border-dashed border-gray-300 rounded-xl max-w-lg w-full mx-4 bg-white">
            <div className="text-5xl mb-4">&#128231;</div>
            <h1 className="text-2xl font-bold text-gray-800 mb-2">PST Viewer</h1>
            <p className="text-gray-500 mb-6">
              Outlook PST-Datei per Drag &amp; Drop oder Men&uuml; &ouml;ffnen
            </p>
            {pst.loading && (
              <div className="mb-4">
                <div className="text-blue-600 font-medium mb-2">
                  <svg className="inline-block w-4 h-4 mr-2 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {pst.loadingMsg}
                </div>
                {pst.loadingPhase === 'copy' && (
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${pst.progress}%` }}
                    />
                  </div>
                )}
                {pst.loadingPhase === 'parse' && (
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-600 h-2 rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]"
                      style={{ width: '30%' }}
                    />
                  </div>
                )}
                {pst.loadingPhase && (
                  <button
                    className="mt-3 px-4 py-1.5 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition"
                    onClick={pst.abortLoad}
                  >
                    Abbrechen
                  </button>
                )}
              </div>
            )}
            {pst.error && (
              <div className="mb-4 text-red-600 bg-red-50 p-3 rounded">{pst.error}</div>
            )}
            <label className={`inline-block px-6 py-3 rounded-lg transition ${pst.loading ? 'bg-gray-400 text-gray-200 cursor-not-allowed' : 'bg-blue-600 text-white cursor-pointer hover:bg-blue-700'}`}>
              PST-Datei ausw&auml;hlen
              <input
                type="file"
                accept=".pst,.ost"
                className="hidden"
                disabled={pst.loading}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
            </label>
            <p className="text-xs text-gray-400 mt-4">
              Alle Daten werden lokal im Browser verarbeitet und gecacht.
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pst,.ost"
          className="hidden"
          disabled={pst.loading}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
        {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
        {showInfo && <InfoDialog onClose={() => setShowInfo(false)} />}
      </div>
    )
  }

  // ── Main view ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-50 text-sm">
      <MenuBar
        fileName={pst.fileName}
        fileSize={pst.fileSize}
        savedAt={pst.savedAt}
        onOpenFile={handleFile}
        onCloseFile={handleClose}
        onShowHelp={() => setShowHelp(true)}
        onShowInfo={() => setShowInfo(true)}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible(v => !v)}
        loading={pst.loading}
        indexProgress={pst.indexProgress}
      />

      {pst.error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center gap-2 text-sm text-red-700">
          <span className="flex-1">{pst.error}</span>
          <button
            className="text-red-400 hover:text-red-600 flex-shrink-0"
            onClick={pst.clearError}
            title="Schließen"
          >&#10005;</button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        {sidebarVisible && (
          <div style={{ width: sidebarWidth }} className="flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
            <div className="flex-1 overflow-y-auto py-1">
              <FolderTreeItem
                folder={pst.tree}
                selectedPath={selectedFolderPath || ''}
                onSelect={handleFolderSelect}
              />
            </div>
          </div>
        )}
        {sidebarVisible && <ResizeHandle onDrag={d => setSidebarWidth(w => clamp(w + d, MIN_SIDEBAR, MAX_SIDEBAR))} />}

        {/* Email List */}
        <div style={{ width: listWidth }} className="flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
          {/* Search Bar */}
          <div className="p-2 border-b border-gray-200">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={selectedFolder ? `Suche in "${selectedFolder.name}" (Strg+F)` : 'Ordner auswählen, dann suchen (Strg+F)'}
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent bg-gray-50"
              />
              {searchQuery && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => { pst.abortSearch(); setSearchQuery(''); searchInputRef.current?.focus() }}
                >
                  &#10005;
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={searchIncludeBody}
                onChange={(e) => setSearchIncludeBody(e.target.checked)}
                className="rounded border-gray-300 text-blue-500 focus:ring-blue-400 h-3.5 w-3.5"
              />
              Auch Inhalt durchsuchen
            </label>
          </div>

          {/* Header */}
          <div className="px-3 py-2 border-b border-gray-100 bg-gray-50/50">
            {isSearching ? (
              <div className="min-w-0 w-full">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800">{searchMatches} Treffer</span>
                  <span className="text-xs text-gray-400 truncate">
                    in {selectedFolder?.name || 'aktuellem Ordner'}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <SortButton field={sortField} direction={sortDirection} onSort={handleSort} />
                    {pst.searching && (
                      <button
                        className="px-2 py-0.5 text-xs text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition"
                        onClick={pst.abortSearch}
                      >
                        Suche abbrechen
                      </button>
                    )}
                    {!pst.searching && pst.searchResults && pst.searchResults.length > 0 && (
                      <ExportDialog
                        count={pst.searchResults.length}
                        label="Treffer"
                        options={exportOptions}
                        onOptionsChange={setExportOptions}
                        onExport={handleSearchExport}
                        exporting={pst.exporting}
                        loadingMsg={pst.loadingMsg}
                        attachmentCount={pst.searchResults.filter(r => r.email.hasAttachments).length}
                      />
                    )}
                  </div>
                </div>
                {pst.searchProgress && (
                  <div className="mt-1.5">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                      <span>
                        {pst.searching
                          ? 'Suche läuft...'
                          : pst.searchProgress.cancelled
                            ? 'Suche abgebrochen'
                            : 'Suche abgeschlossen'}
                      </span>
                      <span>
                        {searchScanned.toLocaleString('de-DE')} / {searchTotal.toLocaleString('de-DE')} Nachrichten
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-blue-600 h-1.5 rounded-full transition-all duration-200"
                        style={{ width: `${searchPercent}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-800 truncate">{selectedFolder?.name || 'Ordner ausw\u00e4hlen'}</div>
                  <div className="text-xs text-gray-400">
                    {selectedFolder ? (
                      selectedFolderPath && pst.folderLoadingPaths.has(selectedFolderPath) ? (
                        `${folderEmailList?.length ?? 0} / ${pst.folderTotalCounts.get(selectedFolderPath) ?? selectedFolder.emailCount} Nachrichten`
                      ) : !folderEmailList && selectedFolder.emailCount > 0 ? (
                        `${selectedFolder.emailCount} Nachrichten (wird geladen...)`
                      ) : (
                        `${folderEmailList?.length ?? selectedFolder.emailCount} Nachrichten`
                      )
                    ) : ''}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <SortButton field={sortField} direction={sortDirection} onSort={handleSort} />
                  {selectedFolderPath && folderEmailList && folderEmailList.length > 0 && !pst.folderLoadingPaths.has(selectedFolderPath) && (
                    <ExportDialog
                      count={folderEmailList.length}
                      label="Nachrichten"
                      options={exportOptions}
                      onOptionsChange={setExportOptions}
                      onExport={handleFolderExport}
                      exporting={pst.exporting}
                      loadingMsg={pst.loadingMsg}
                      attachmentCount={folderEmailList.filter(e => e.hasAttachments).length}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Email Rows — virtualized */}
          <VirtualEmailList
            emails={sortedEmails}
            searchResults={isSearching ? sortedSearchResults ?? null : null}
            isSearching={isSearching}
            searching={pst.searching}
            query={debouncedQuery}
            selectedFolderPath={selectedFolderPath || ''}
            selectedIndex={selectedEmail?.index ?? null}
            selectedFolderPathForSelection={selectedEmail?.folderPath ?? null}
            onSelect={handleEmailSelect}
          />
        </div>

        <ResizeHandle onDrag={d => setListWidth(w => clamp(w + d, MIN_LIST, MAX_LIST))} />

        {/* Email Detail */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {selectedEmail ? (
            <>
              <div className="p-4 border-b border-gray-200 bg-white">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedEmail.subject}
                  </h2>
                  <button
                    onClick={() => pst.shareEmail(selectedEmail.folderPath, selectedEmail.index)}
                    title="E-Mail teilen"
                    disabled={pst.searching}
                    className="shrink-0 p-1.5 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7" />
                      <polyline points="16 6 12 2 8 6" />
                      <line x1="12" y1="2" x2="12" y2="15" />
                    </svg>
                  </button>
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {selectedEmail.itemType === 'contact' ? (
                    <>
                      {selectedEmail.contactName && (
                        <>
                          <span className="text-gray-400">Name:</span>
                          <span className="text-gray-700">{selectedEmail.contactName}</span>
                        </>
                      )}
                      {selectedEmail.contactCompany && (
                        <>
                          <span className="text-gray-400">Firma:</span>
                          <span className="text-gray-700">{selectedEmail.contactCompany}</span>
                        </>
                      )}
                      {selectedEmail.contactTitle && (
                        <>
                          <span className="text-gray-400">Position:</span>
                          <span className="text-gray-700">{selectedEmail.contactTitle}</span>
                        </>
                      )}
                      {selectedEmail.contactEmail && (
                        <>
                          <span className="text-gray-400">E-Mail:</span>
                          <span className="text-gray-700">{selectedEmail.contactEmail}</span>
                        </>
                      )}
                      {selectedEmail.contactPhone && (
                        <>
                          <span className="text-gray-400">Telefon:</span>
                          <span className="text-gray-700">{selectedEmail.contactPhone}</span>
                        </>
                      )}
                      {selectedEmail.contactAddress && (
                        <>
                          <span className="text-gray-400">Adresse:</span>
                          <span className="text-gray-700 whitespace-pre-line">{selectedEmail.contactAddress}</span>
                        </>
                      )}
                    </>
                  ) : selectedEmail.itemType === 'appointment' ? (
                    <>
                      {selectedEmail.startTime && (
                        <>
                          <span className="text-gray-400">Beginn:</span>
                          <span className="text-gray-700">{formatDate(selectedEmail.startTime)}</span>
                        </>
                      )}
                      {selectedEmail.endTime && (
                        <>
                          <span className="text-gray-400">Ende:</span>
                          <span className="text-gray-700">{formatDate(selectedEmail.endTime)}</span>
                        </>
                      )}
                      {!!selectedEmail.duration && (
                        <>
                          <span className="text-gray-400">Dauer:</span>
                          <span className="text-gray-700">{selectedEmail.duration} Minuten</span>
                        </>
                      )}
                      {selectedEmail.location && (
                        <>
                          <span className="text-gray-400">Ort:</span>
                          <span className="text-gray-700">{selectedEmail.location}</span>
                        </>
                      )}
                      {selectedEmail.attendees && (
                        <>
                          <span className="text-gray-400">Teilnehmer:</span>
                          <span className="text-gray-700">{selectedEmail.attendees}</span>
                        </>
                      )}
                      {selectedEmail.senderName && (
                        <>
                          <span className="text-gray-400">Organisator:</span>
                          <span className="text-gray-700">{selectedEmail.senderName}</span>
                        </>
                      )}
                      {selectedEmail.isRecurring && (
                        <>
                          <span className="text-gray-400">Wiederholung:</span>
                          <span className="text-gray-700">{selectedEmail.recurrencePattern || 'Ja'}</span>
                        </>
                      )}
                      {selectedEmail.displayTo && (
                        <>
                          <span className="text-gray-400">An:</span>
                          <span className="text-gray-700">{selectedEmail.displayTo}</span>
                        </>
                      )}
                    </>
                  ) : selectedEmail.itemType === 'task' ? (
                    <>
                      <span className="text-gray-400">Status:</span>
                      <span className="text-gray-700">
                        {['Nicht begonnen', 'In Bearbeitung', 'Erledigt', 'Wartend', 'Zurückgestellt'][selectedEmail.taskStatus ?? 0] ?? 'Unbekannt'}
                        {selectedEmail.percentComplete != null && ` (${selectedEmail.percentComplete}%)`}
                      </span>
                      {selectedEmail.taskOwner && (
                        <>
                          <span className="text-gray-400">Besitzer:</span>
                          <span className="text-gray-700">{selectedEmail.taskOwner}</span>
                        </>
                      )}
                      {selectedEmail.date && (
                        <>
                          <span className="text-gray-400">F&auml;llig:</span>
                          <span className="text-gray-700">{formatDate(selectedEmail.date)}</span>
                        </>
                      )}
                      {selectedEmail.senderName && (
                        <>
                          <span className="text-gray-400">Von:</span>
                          <span className="text-gray-700">{selectedEmail.senderName}</span>
                        </>
                      )}
                      {selectedEmail.displayTo && (
                        <>
                          <span className="text-gray-400">An:</span>
                          <span className="text-gray-700">{selectedEmail.displayTo}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-gray-400">Von:</span>
                      <span className="text-gray-700">
                        {selectedEmail.senderName}
                        {selectedEmail.senderEmail && (
                          <span className="text-gray-400 ml-1">&lt;{selectedEmail.senderEmail}&gt;</span>
                        )}
                      </span>
                      <span className="text-gray-400">An:</span>
                      <span className="text-gray-700">{selectedEmail.displayTo}</span>
                      {selectedEmail.displayCC && (
                        <>
                          <span className="text-gray-400">CC:</span>
                          <span className="text-gray-700">{selectedEmail.displayCC}</span>
                        </>
                      )}
                      <span className="text-gray-400">Datum:</span>
                      <span className="text-gray-700">{formatDate(selectedEmail.date)}</span>
                    </>
                  )}
                  {isSearching && (
                    <>
                      <span className="text-gray-400">Ordner:</span>
                      <span className="text-gray-700">{selectedEmail.folderPath}</span>
                    </>
                  )}
                </div>
                {selectedEmail.hasAttachments && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedEmail.attachmentNames.map((name, i) => (
                      <button key={i} onClick={() => pst.fetchAttachment(selectedEmail.folderPath, selectedEmail.index, i)}
                        disabled={pst.searching}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded text-xs text-gray-600 hover:bg-blue-100 hover:text-blue-700 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-100 disabled:hover:text-gray-600">
                        &#128206; {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 bg-white">
                {selectedBody ? (
                  selectedBody.bodyHTML ? (
                    <iframe
                      srcDoc={selectedBody.bodyHTML}
                      className="w-full h-full border-0"
                      sandbox="allow-same-origin"
                      title="Email content"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-gray-700 font-sans text-sm">{selectedBody.body}</pre>
                  )
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <svg className="inline-block w-4 h-4 mr-2 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Wird geladen...
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center">
                <div className="text-4xl mb-2">&#9993;</div>
                <p>Nachricht ausw&auml;hlen</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pst,.ost"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />

      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showInfo && <InfoDialog onClose={() => setShowInfo(false)} />}

      {showSplash && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 cursor-pointer select-none"
          onClick={() => setShowSplash(false)}
          onKeyDown={() => setShowSplash(false)}
          tabIndex={0}
          ref={(el) => el?.focus()}
        >
          <div className="text-center animate-[fadeIn_0.6s_ease-out]">
            <div className="text-sm md:text-base font-semibold tracking-[0.3em] uppercase text-blue-400/70 mb-3">
              MEUSE24
            </div>
            <div className="text-6xl md:text-8xl font-black tracking-tight text-white mb-2 drop-shadow-lg">
              PST <span className="text-blue-400">Titan</span>
            </div>
            <div className="text-lg md:text-xl text-blue-300/80 font-medium tracking-wide">
              Schluckt 50 GB zum Fr&uuml;hst&uuml;ck
            </div>
            <div className="mt-8 text-sm text-slate-500 animate-pulse">
              Klicken oder beliebige Taste dr&uuml;cken
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
