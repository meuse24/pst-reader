import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { EmailMeta, SearchResult } from './types.ts'

function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

function ImportanceBadge({ importance }: { importance: number }) {
  if (importance === 2) return <span className="text-red-500 text-xs font-bold" title="Hoch">!</span>
  if (importance === 0) return <span className="text-blue-400 text-xs" title="Niedrig">&darr;</span>
  return null
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function getSnippet(bodySnippet: string, query: string, radius = 60): string {
  const lower = bodySnippet.toLowerCase()
  const terms = query.trim().toLowerCase().split(/\s+/)
  let bestIdx = -1
  for (const t of terms) {
    const idx = lower.indexOf(t)
    if (idx !== -1) { bestIdx = idx; break }
  }
  if (bestIdx === -1) return bodySnippet.slice(0, 120)
  const start = Math.max(0, bestIdx - radius)
  const end = Math.min(bodySnippet.length, bestIdx + radius)
  return (start > 0 ? '...' : '') + bodySnippet.slice(start, end) + (end < bodySnippet.length ? '...' : '')
}

interface VirtualEmailListProps {
  emails: EmailMeta[]
  searchResults: SearchResult[] | null
  isSearching: boolean
  searching: boolean
  query: string
  selectedFolderPath: string
  selectedIndex: number | null
  selectedFolderPathForSelection: string | null
  onSelect: (email: EmailMeta) => void
}

export function VirtualEmailList({
  emails,
  searchResults,
  isSearching,
  searching,
  query,
  selectedFolderPath,
  selectedIndex,
  selectedFolderPathForSelection,
  onSelect,
}: VirtualEmailListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  // eslint-disable-next-line react-hooks/incompatible-library -- React Compiler skip is acceptable
  const virtualizer = useVirtualizer({
    count: emails.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  })

  if (emails.length === 0) {
    if (isSearching) {
      if (searching) {
        return (
          <div className="p-6 text-center text-gray-400">
            <svg className="inline-block w-4 h-4 mr-2 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Suche l&auml;uft...
          </div>
        )
      }
      return (
        <div className="p-6 text-center text-gray-400">
          <div className="text-2xl mb-2">&#128269;</div>
          Keine Treffer f&uuml;r &bdquo;{query}&ldquo;
        </div>
      )
    }
    return (
      <div className="p-6 text-center text-gray-400">Keine Nachrichten in diesem Ordner</div>
    )
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const email = emails[virtualRow.index]
          const result = isSearching && searchResults ? searchResults[virtualRow.index] : null
          const isSelected = selectedIndex === email.index && selectedFolderPathForSelection === email.folderPath

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div
                className={`px-3 py-2 border-b border-gray-100 cursor-pointer hover:bg-blue-50 ${
                  isSelected ? 'bg-blue-50' : ''
                } ${!email.isRead ? 'bg-gray-50' : ''}`}
                onClick={() => onSelect(email)}
              >
                <div className="flex items-center gap-1">
                  {!email.isRead && <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />}
                  <ImportanceBadge importance={email.importance} />
                  <span className="font-medium text-gray-800 truncate">
                    {isSearching
                      ? <HighlightText text={email.senderName || email.senderEmail || 'Unbekannt'} query={query} />
                      : email.senderName || email.senderEmail || 'Unbekannt'}
                  </span>
                  <span className="text-xs text-gray-400 ml-auto flex-shrink-0 whitespace-nowrap">
                    {formatDate(email.date)}
                  </span>
                </div>
                <div className="text-gray-700 truncate mt-0.5">
                  {isSearching
                    ? <HighlightText text={email.subject} query={query} />
                    : email.subject}
                </div>
                <div className="text-xs text-gray-400 truncate mt-0.5">
                  {isSearching
                    ? <HighlightText text={getSnippet(email.bodySnippet, query)} query={query} />
                    : email.bodySnippet.slice(0, 100)}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {email.hasAttachments && (
                    <span className="text-xs text-gray-400">&#128206; {email.numberOfAttachments}</span>
                  )}
                  {isSearching && result && (
                    <>
                      <span className="text-xs text-blue-500 bg-blue-50 px-1.5 rounded">{result.matchField}</span>
                      {result.folderPath !== selectedFolderPath && (
                        <span className="text-xs text-gray-400 truncate" title={result.folderPath}>
                          {result.folderPath.split(' / ').pop()}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
