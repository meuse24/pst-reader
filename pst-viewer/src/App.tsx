import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { usePSTWorker, bodyKey } from './usePSTWorker.ts'
import { VirtualEmailList } from './VirtualEmailList.tsx'
import type { FolderNode, EmailMeta, ExportOptions } from './types.ts'

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
            <h2 className="text-base font-semibold text-gray-800 mb-1">Suche</h2>
            <p className="text-sm text-gray-600">
              Mit <b>Strg+F</b> oder Klick auf das Suchfeld k&ouml;nnen Sie nach E-Mails suchen.
              Die Suche durchsucht Betreff, Absender, Empf&auml;nger und Anh&auml;nge aller bisher besuchten Ordner.
              Mehrere Suchbegriffe werden mit UND verkn&uuml;pft. Die Suche ist nicht Gross-/Kleinschreibung-sensitiv.
              Mit <b>Escape</b> wird die Suche geschlossen.
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

// ─── Menu dropdown ───────────────────────────────────────────────────────────

function MenuBar({
  fileName,
  fileSize,
  savedAt,
  onOpenFile,
  onCloseFile,
  onShowHelp,
  onShowInfo,
}: {
  fileName: string
  fileSize: number
  savedAt: number
  onOpenFile: (file: File) => void
  onCloseFile: () => void
  onShowHelp: () => void
  onShowInfo: () => void
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
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 flex items-center gap-3"
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exportOptions, setExportOptions] = useState<ExportOptions>({ includeHTML: true, includeTXT: true, includeAttachments: false })
  const [showHelp, setShowHelp] = useState(false)
  const [showInfo, setShowInfo] = useState(false)

  const debouncedQuery = useDebounce(searchQuery, 200)
  const isSearching = debouncedQuery.trim().length > 0

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
    if (debouncedQuery.trim()) {
      pst.search(debouncedQuery)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  // Get emails for current view
  const folderEmailList = selectedFolderPath ? pst.folderEmails.get(selectedFolderPath) : undefined
  const displayEmails = isSearching
    ? (pst.searchResults || []).map(r => r.email)
    : folderEmailList || []

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

  const handleFolderSelect = useCallback((folder: FolderNode) => {
    setSelectedFolderPath(folder.path)
    setSelectedEmail(null)
    setSearchQuery('')
    pst.fetchFolder(folder.path)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = useCallback((file: File) => {
    setSelectedEmail(null)
    setSelectedFolderPath(null)
    setSearchQuery('')
    pst.loadFile(file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(() => {
    setSelectedEmail(null)
    setSelectedFolderPath(null)
    setSearchQuery('')
    pst.closeFile()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
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
        fileInputRef.current?.click()
      }
      if (e.key === 'Escape' && isSearching) {
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
      if (e.key === 'F1') {
        e.preventDefault()
        setShowHelp(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isSearching])

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
                {pst.progress > 0 && (
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${pst.progress}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {pst.error && (
              <div className="mb-4 text-red-600 bg-red-50 p-3 rounded">{pst.error}</div>
            )}
            <label className="inline-block bg-blue-600 text-white px-6 py-3 rounded-lg cursor-pointer hover:bg-blue-700 transition">
              PST-Datei ausw&auml;hlen
              <input
                type="file"
                accept=".pst,.ost"
                className="hidden"
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
      />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-64 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
          <div className="flex-1 overflow-y-auto py-1">
            <FolderTreeItem
              folder={pst.tree}
              selectedPath={selectedFolderPath || ''}
              onSelect={handleFolderSelect}
            />
          </div>
        </div>

        {/* Email List */}
        <div className="w-96 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
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
                placeholder={`Suche in ${pst.indexedFolderCount} Ordner(n) (Strg+F)`}
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent bg-gray-50"
              />
              {searchQuery && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }}
                >
                  &#10005;
                </button>
              )}
            </div>
          </div>

          {/* Header */}
          <div className="px-3 py-2 border-b border-gray-100 bg-gray-50/50">
            {isSearching ? (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-800">{pst.searchResults?.length || 0} Treffer</span>
                <span className="text-xs text-gray-400">
                  in {pst.indexedFolderCount} besuchten Ordner(n)
                </span>
                {pst.searchResults && pst.searchResults.length > 0 && (
                  <div className="ml-auto">
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
                {selectedFolderPath && folderEmailList && folderEmailList.length > 0 && !pst.folderLoadingPaths.has(selectedFolderPath) && (
                  <div className="ml-auto flex-shrink-0">
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
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Email Rows — virtualized */}
          <VirtualEmailList
            emails={displayEmails}
            searchResults={isSearching ? pst.searchResults : null}
            isSearching={isSearching}
            query={debouncedQuery}
            selectedFolderPath={selectedFolderPath || ''}
            selectedIndex={selectedEmail?.index ?? null}
            selectedFolderPathForSelection={selectedEmail?.folderPath ?? null}
            onSelect={handleEmailSelect}
          />
        </div>

        {/* Email Detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedEmail ? (
            <>
              <div className="p-4 border-b border-gray-200 bg-white">
                <h2 className="text-lg font-semibold text-gray-900 mb-2">
                  {selectedEmail.subject}
                </h2>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
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
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded text-xs text-gray-600">
                        &#128206; {name}
                      </span>
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
    </div>
  )
}

export default App
