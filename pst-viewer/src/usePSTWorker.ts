import { useState, useEffect, useCallback, useRef } from 'react'
import PSTWorkerConstructor from './pstWorker.ts?worker&inline'
import type { FolderNode, EmailMeta, SearchResult, WorkerCommand, WorkerResponse, ExportOptions } from './types.ts'

export interface PSTWorkerState {
  tree: FolderNode | null
  fileName: string
  fileSize: number
  savedAt: number
  loading: boolean
  loadingMsg: string
  progress: number
  error: string | null
  folderEmails: Map<string, EmailMeta[]>
  bodyCache: Map<string, { body: string; bodyHTML: string }>
  searchResults: SearchResult[] | null
  indexedFolderCount: number
  folderTotalCounts: Map<string, number>
  folderLoadingPaths: Set<string>
  exporting: boolean
}

export interface PSTWorkerActions {
  loadFile: (file: File) => void
  fetchFolder: (path: string) => void
  fetchBody: (folderPath: string, index: number) => void
  search: (query: string) => void
  closeFile: () => void
  exportEmails: (emails: Array<{ folderPath: string; index: number }>, options: ExportOptions) => void
  exportFolder: (folderPath: string, options: ExportOptions) => void
}

const MAX_BODY_CACHE = 100

function bodyKey(folderPath: string, index: number) {
  return `${folderPath}\0${index}`
}

export function usePSTWorker(): PSTWorkerState & PSTWorkerActions {
  const workerRef = useRef<Worker | null>(null)
  const bodyCacheRef = useRef<Map<string, { body: string; bodyHTML: string }>>(new Map())

  const [tree, setTree] = useState<FolderNode | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [savedAt, setSavedAt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMsg, setLoadingMsg] = useState('Gespeicherte Datei wird geladen...')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [folderEmails, setFolderEmails] = useState<Map<string, EmailMeta[]>>(new Map())
  const [bodyCache, setBodyCache] = useState<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searchableFolderCount, setSearchableFolderCount] = useState(0)
  const [folderTotalCounts, setFolderTotalCounts] = useState<Map<string, number>>(new Map())
  const [folderLoadingPaths, setFolderLoadingPaths] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  // Use worker-reported searchable count (reflects LRU eviction), not local map size
  const indexedFolderCount = searchableFolderCount

  // Send command to worker
  const send = useCallback((cmd: WorkerCommand, transfer?: Transferable[]) => {
    if (!workerRef.current) return
    if (transfer) {
      workerRef.current.postMessage(cmd, transfer)
    } else {
      workerRef.current.postMessage(cmd)
    }
  }, [])

  // Initialize worker + load from cache on mount
  useEffect(() => {
    const worker = new PSTWorkerConstructor()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'READY':
          setTree(msg.tree)
          setFileName(msg.fileName)
          setFileSize(msg.fileSize)
          setSavedAt(msg.savedAt)
          setLoading(false)
          setLoadingMsg('')
          setProgress(0)
          setError(null)
          setFolderEmails(new Map())
          setBodyCache(new Map())
          bodyCacheRef.current = new Map()
          setSearchableFolderCount(0)
          setFolderTotalCounts(new Map())
          setFolderLoadingPaths(new Set())
          break

        case 'FOLDER_EMAILS':
          setFolderEmails(prev => {
            const next = new Map(prev)
            if (msg.page === 0) {
              next.set(msg.path, msg.emails)
            } else {
              const existing = prev.get(msg.path)
              next.set(msg.path, existing ? [...existing, ...msg.emails] : msg.emails)
            }
            return next
          })
          setSearchableFolderCount(msg.searchableFolderCount)
          setFolderTotalCounts(prev => {
            const next = new Map(prev)
            next.set(msg.path, msg.totalCount)
            return next
          })
          if (msg.page === 0) {
            // Only one folder loads at a time — clear any stuck paths from cancelled loads
            setFolderLoadingPaths(new Set([msg.path]))
          }
          break

        case 'FOLDER_DONE':
          setFolderLoadingPaths(prev => {
            const next = new Set(prev)
            next.delete(msg.path)
            return next
          })
          setFolderTotalCounts(prev => {
            const next = new Map(prev)
            next.set(msg.path, msg.totalCount)
            return next
          })
          break

        case 'EMAIL_BODY':
          setBodyCache(prev => {
            const next = new Map(prev)
            next.set(bodyKey(msg.folderPath, msg.index), { body: msg.body, bodyHTML: msg.bodyHTML })
            // LRU eviction: remove oldest entries if over limit
            if (next.size > MAX_BODY_CACHE) {
              const iter = next.keys()
              while (next.size > MAX_BODY_CACHE) {
                const oldest = iter.next()
                if (oldest.done) break
                next.delete(oldest.value)
              }
            }
            bodyCacheRef.current = next
            return next
          })
          break

        case 'SEARCH_RESULTS':
          setSearchResults(msg.results)
          break

        case 'EXPORT_READY': {
          setExporting(false)
          setLoadingMsg('')
          // Trigger auto-download
          const blob = new Blob([msg.zipBuffer], { type: 'application/zip' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = msg.fileName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          break
        }

        case 'PROGRESS':
          setLoadingMsg(msg.message)
          if (msg.percent !== undefined) setProgress(msg.percent)
          break

        case 'ERROR':
          if (msg.message) {
            setError(msg.message)
          }
          setLoading(false)
          setExporting(false)
          setLoadingMsg('')
          setProgress(0)
          break

        case 'CACHE_DELETED':
          setTree(null)
          setFileName('')
          setFileSize(0)
          setSavedAt(0)
          setFolderEmails(new Map())
          setBodyCache(new Map())
          bodyCacheRef.current = new Map()
          setSearchResults(null)
          setError(null)
          setProgress(0)
          setSearchableFolderCount(0)
          setFolderTotalCounts(new Map())
          setFolderLoadingPaths(new Set())
          break
      }
    }

    worker.onerror = (err) => {
      setError(err.message || 'Worker-Fehler')
      setLoading(false)
    }

    // Auto-load from OPFS cache
    worker.postMessage({ type: 'LOAD_CACHED' } satisfies WorkerCommand)

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const loadFile = useCallback((file: File) => {
    setLoading(true)
    setLoadingMsg('Datei wird vorbereitet...')
    setProgress(0)
    setError(null)
    setSearchResults(null)
    send({ type: 'LOAD_FILE', file })
  }, [send])

  const fetchFolder = useCallback((path: string) => {
    send({ type: 'FETCH_FOLDER', path })
  }, [send])

  const fetchBody = useCallback((folderPath: string, index: number) => {
    // Skip if already cached (use ref to avoid stale closure)
    if (bodyCacheRef.current.has(bodyKey(folderPath, index))) return
    send({ type: 'FETCH_BODY', folderPath, index })
  }, [send])

  const search = useCallback((query: string) => {
    send({ type: 'SEARCH', query })
  }, [send])

  const closeFile = useCallback(() => {
    send({ type: 'DELETE_CACHE' })
  }, [send])

  const exportEmails = useCallback((emails: Array<{ folderPath: string; index: number }>, options: ExportOptions) => {
    setExporting(true)
    setLoadingMsg('Export wird vorbereitet...')
    send({ type: 'EXPORT_EMAILS', emails, options })
  }, [send])

  const exportFolder = useCallback((folderPath: string, options: ExportOptions) => {
    setExporting(true)
    setLoadingMsg('Export wird vorbereitet...')
    send({ type: 'EXPORT_FOLDER', folderPath, options })
  }, [send])

  return {
    tree, fileName, fileSize, savedAt,
    loading, loadingMsg, progress, error,
    folderEmails, bodyCache, searchResults,
    indexedFolderCount,
    folderTotalCounts, folderLoadingPaths,
    exporting,
    loadFile, fetchFolder, fetchBody, search, closeFile, exportEmails, exportFolder,
  }
}

export { bodyKey }
