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

// ─── Menu dropdown ───────────────────────────────────────────────────────────

function MenuBar({
  fileName,
  fileSize,
  savedAt,
  onOpenFile,
  onCloseFile,
}: {
  fileName: string
  fileSize: number
  savedAt: number
  onOpenFile: (file: File) => void
  onCloseFile: () => void
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

  const [showExportDialog, setShowExportDialog] = useState(false)
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ includeHTML: true, includeTXT: true, includeAttachments: false })
  const exportDialogRef = useRef<HTMLDivElement>(null)

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
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isSearching])

  // Close export dialog on outside click
  useEffect(() => {
    if (!showExportDialog) return
    const handler = (e: MouseEvent) => {
      if (exportDialogRef.current && !exportDialogRef.current.contains(e.target as Node)) setShowExportDialog(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showExportDialog])

  const handleExport = useCallback(() => {
    if (!pst.searchResults || pst.searchResults.length === 0) return
    const emails = pst.searchResults.map(r => ({ folderPath: r.folderPath, index: r.email.index }))
    pst.exportEmails(emails, exportOptions)
    setShowExportDialog(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pst.searchResults, exportOptions])

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
                  <div className="relative ml-auto" ref={exportDialogRef}>
                    <button
                      className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      onClick={() => setShowExportDialog(!showExportDialog)}
                      disabled={pst.exporting}
                    >
                      {pst.exporting ? (
                        <>
                          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          {pst.loadingMsg || 'Exportiert...'}
                        </>
                      ) : 'Exportieren'}
                    </button>
                    {showExportDialog && !pst.exporting && (
                      <div className="absolute right-0 top-full mt-1 w-64 bg-white rounded-lg shadow-xl border border-gray-200 p-3 z-50">
                        <div className="text-xs font-semibold text-gray-600 mb-2">Export-Optionen</div>
                        <label className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={exportOptions.includeHTML}
                            onChange={(e) => setExportOptions(prev => ({ ...prev, includeHTML: e.target.checked }))}
                            className="rounded"
                          />
                          HTML-Inhalt
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 mb-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={exportOptions.includeTXT}
                            onChange={(e) => setExportOptions(prev => ({ ...prev, includeTXT: e.target.checked }))}
                            className="rounded"
                          />
                          Textinhalt
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={exportOptions.includeAttachments}
                            onChange={(e) => setExportOptions(prev => ({ ...prev, includeAttachments: e.target.checked }))}
                            className="rounded"
                          />
                          Anh&auml;nge einschlie&szlig;en
                        </label>
                        <button
                          className="w-full px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50"
                          onClick={handleExport}
                          disabled={!exportOptions.includeHTML && !exportOptions.includeTXT}
                        >
                          {pst.searchResults?.length} Treffer als ZIP exportieren
                        </button>
                        {!exportOptions.includeHTML && !exportOptions.includeTXT && (
                          <div className="text-xs text-red-500 mt-1">Mindestens ein Inhaltsformat w&auml;hlen</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="font-semibold text-gray-800">{selectedFolder?.name || 'Ordner ausw\u00e4hlen'}</div>
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
              </>
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
    </div>
  )
}

export default App
