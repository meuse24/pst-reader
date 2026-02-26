/// <reference lib="webworker" />

import { Buffer } from 'buffer'
import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor'
// PSTUtil is not exported from pst-extractor index, import directly
import { PSTUtil } from 'pst-extractor/dist/PSTUtil.class'

import { zipSync } from 'fflate'
import type { WorkerCommand, WorkerResponse, FolderNode, EmailMeta, SearchResult, ExportOptions } from './types.ts'

;(globalThis as unknown as Record<string, unknown>).Buffer = Buffer

// ─── Monkey-patch PSTUtil.arraycopy: use Buffer.set instead of byte-by-byte ──

PSTUtil.arraycopy = function (src: Buffer, srcPos: number, dest: Buffer, destPos: number, length: number) {
  const srcView = src.subarray(srcPos, srcPos + length)
  dest.set(srcView, destPos)
}

// ─── OPFS capability detection ──────────────────────────────────────────────

/** Actually probe OPFS — the APIs exist on file:// but calls fail */
async function probeOpfs(): Promise<boolean> {
  try {
    if (typeof navigator?.storage?.getDirectory !== 'function') return false
    if (typeof FileSystemFileHandle?.prototype?.createSyncAccessHandle !== 'function') return false
    // Real probe: try to get the OPFS root (fails on file://)
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

async function checkStorageCapacity(requiredBytes: number): Promise<{ ok: boolean; available: number }> {
  const est = await navigator.storage.estimate()
  const available = (est.quota ?? 0) - (est.usage ?? 0)
  return { ok: available > requiredBytes * 1.1 + 50_000_000, available }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

// ─── Worker state ────────────────────────────────────────────────────────────

let pstFile: PSTFile | null = null
let pstBuffer: Buffer | null = null
let syncHandle: FileSystemSyncAccessHandle | null = null
let opfsMode = false
let currentFileName = ''
let currentFileSize = 0
let loadOpId = 0 // operation counter for aborting stale loads

const FIRST_PAGE_SIZE = 50
const PAGE_SIZE = 200
const PAGINATION_THRESHOLD = 500
const SEARCH_RESULT_PAGE_SIZE = 200
const SEARCH_PROGRESS_INTERVAL = 300
const SEARCH_YIELD_INTERVAL = 50

const folderCache = new Map<string, PSTFolder>()
const emailCache = new Map<string, EmailMeta[]>()
const completedFolders = new Set<string>()
let folderLoadOpId = 0
let searchOpId = 0

// Store original readSync so we can restore it for legacy mode
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pstProto = PSTFile.prototype as any
const originalReadSync = pstProto.readSync as (buffer: Buffer, length: number, position: number) => number

// ─── IndexedDB helpers (metadata only — no file data) ────────────────────────

const DB_NAME = 'pst-viewer'
const DB_VERSION = 1
const STORE_NAME = 'files'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

async function saveMetadataToIDB(fileName: string, fileSize: number): Promise<number> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  store.put(fileName, 'pst-name')
  store.put(fileSize, 'pst-size')
  const savedAt = Date.now()
  store.put(savedAt, 'pst-saved-at')
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
  return savedAt
}

async function loadMetadataFromIDB(): Promise<{ fileName: string; fileSize: number; savedAt: number } | null> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  const [name, size, savedAt] = await Promise.all([
    idbGet<string>(store, 'pst-name'),
    idbGet<number>(store, 'pst-size'),
    idbGet<number>(store, 'pst-saved-at'),
  ])
  db.close()
  if (!name || !size) return null
  return { fileName: name, fileSize: size, savedAt: savedAt || 0 }
}

async function clearMetadataFromIDB(): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).clear()
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

// ─── readSync Monkey-Patch with parse progress ─────────────────────────────

let parseProgressEnabled = false
let parseBytesRead = 0
let parseLastReportTime = 0
const PARSE_PROGRESS_INTERVAL = 2000

function reportParseProgress() {
  const now = performance.now()
  if (now - parseLastReportTime < PARSE_PROGRESS_INTERVAL) return
  parseLastReportTime = now
  post({
    type: 'PROGRESS',
    message: `PST wird verarbeitet... (${formatBytes(parseBytesRead)} gelesen)`,
    phase: 'parse',
  })
}

function patchReadSync() {
  pstProto.readSync = function (
    buffer: Buffer, length: number, position: number
  ): number {
    if (!syncHandle) throw new Error('OPFS handle not available')
    const view = new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, length)
    const bytesRead = syncHandle.read(view, { at: position })
    if (bytesRead < length) {
      throw new Error(`Short read: expected ${length}, got ${bytesRead} at position ${position}`)
    }
    if (parseProgressEnabled) {
      parseBytesRead += bytesRead
      reportParseProgress()
    }
    return bytesRead
  }
}

function restoreReadSync() {
  pstProto.readSync = originalReadSync
}

// ─── FileReaderSync chunk cache (for file:// URLs without OPFS) ─────────────

let fileRef: File | null = null

const CHUNK_SIZE = 4 * 1024 * 1024 // 4 MB
const MAX_CHUNKS = 8               // 32 MB max cache
const chunkCache = new Map<number, ArrayBuffer>()
const chunkLRU: number[] = []

function readChunk(chunkIndex: number): ArrayBuffer {
  const cached = chunkCache.get(chunkIndex)
  if (cached) {
    const i = chunkLRU.indexOf(chunkIndex)
    if (i >= 0) chunkLRU.splice(i, 1)
    chunkLRU.push(chunkIndex)
    return cached
  }
  if (!fileRef) throw new Error('Datei-Referenz nicht verfügbar — wurde die Datei entfernt?')
  const start = chunkIndex * CHUNK_SIZE
  const end = Math.min(start + CHUNK_SIZE, fileRef.size)
  const slice = fileRef.slice(start, end)
  let ab: ArrayBuffer
  try {
    const reader = new FileReaderSync()
    ab = reader.readAsArrayBuffer(slice)
  } catch (err) {
    throw new Error(`Datei konnte nicht gelesen werden (Position ${start}): ${err instanceof Error ? err.message : String(err)}`)
  }
  while (chunkCache.size >= MAX_CHUNKS) {
    const oldest = chunkLRU.shift()!
    chunkCache.delete(oldest)
  }
  chunkCache.set(chunkIndex, ab)
  chunkLRU.push(chunkIndex)
  return ab
}

function clearChunkCache() {
  chunkCache.clear()
  chunkLRU.length = 0
}

function patchReadSyncFile() {
  pstProto.readSync = function (
    buffer: Buffer, length: number, position: number
  ): number {
    if (!fileRef) throw new Error('File reference not available')
    const dest = new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, length)
    let bytesRead = 0
    while (bytesRead < length) {
      const absPos = position + bytesRead
      const chunkIndex = Math.floor(absPos / CHUNK_SIZE)
      const chunkData = readChunk(chunkIndex)
      const offsetInChunk = absPos - chunkIndex * CHUNK_SIZE
      const available = chunkData.byteLength - offsetInChunk
      const toCopy = Math.min(available, length - bytesRead)
      dest.set(new Uint8Array(chunkData, offsetInChunk, toCopy), bytesRead)
      bytesRead += toCopy
    }
    if (parseProgressEnabled) {
      parseBytesRead += bytesRead
      reportParseProgress()
    }
    return bytesRead
  }
}

// ─── PST helpers ─────────────────────────────────────────────────────────────

function buildFolderTree(folder: PSTFolder, parentPath = ''): FolderNode {
  const name = folder.displayName || 'Root'
  const path = parentPath ? `${parentPath} / ${name}` : name
  const children: FolderNode[] = []

  // Cache the PSTFolder reference for later email fetching
  folderCache.set(path, folder)

  try {
    for (const sub of folder.getSubFolders()) {
      children.push(buildFolderTree(sub, path))
    }
  } catch { /* no subfolders */ }

  return {
    name,
    emailCount: folder.emailCount,
    subFolderCount: folder.subFolderCount,
    children,
    path,
  }
}

function buildSearchText(subject: string, senderName: string, senderEmail: string, displayTo: string, displayCC: string, attachmentNames: string[]): string {
  return [subject, senderName, senderEmail, displayTo, displayCC, ...attachmentNames].join('\0').toLowerCase()
}

function buildBodySnippet(body: string, terms: string[], radius = 80): string {
  const compact = body.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const lower = compact.toLowerCase()
  let bestIdx = -1
  for (const t of terms) {
    const idx = lower.indexOf(t)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx
  }
  if (bestIdx === -1) return compact.slice(0, 200)
  const start = Math.max(0, bestIdx - radius)
  const end = Math.min(compact.length, bestIdx + radius)
  return (start > 0 ? '...' : '') + compact.slice(start, end) + (end < compact.length ? '...' : '')
}

function detectMatchField(email: EmailMeta, terms: string[], bodyLower: string): string {
  const subject = email.subject.toLowerCase()
  const senderName = email.senderName.toLowerCase()
  const senderEmail = email.senderEmail.toLowerCase()
  const recipients = (email.displayTo + '\0' + email.displayCC).toLowerCase()
  const attachments = email.attachmentNames.map(n => n.toLowerCase())
  for (const t of terms) {
    if (subject.includes(t)) return 'Betreff'
    if (senderName.includes(t) || senderEmail.includes(t)) return 'Absender'
    if (recipients.includes(t)) return 'Empfänger'
    if (attachments.some(name => name.includes(t))) return 'Anhang'
    if (bodyLower.includes(t)) return 'Inhalt'
  }
  return 'Inhalt'
}

function extractEmailMeta(email: PSTMessage, index: number, folderPath: string): EmailMeta {
  const attachmentNames: string[] = []
  for (let i = 0; i < email.numberOfAttachments; i++) {
    try {
      const att = email.getAttachment(i)
      attachmentNames.push(att.displayName || att.filename || `Attachment ${i + 1}`)
    } catch { /* skip */ }
  }

  const subject = email.subject || '(Kein Betreff)'
  const senderName = email.senderName || ''
  const senderEmail = email.senderEmailAddress || ''
  const displayTo = email.displayTo || ''
  const displayCC = email.displayCC || ''
  const date = email.clientSubmitTime || email.messageDeliveryTime || null

  // In OPFS mode, skip body loading for snippets (expensive I/O per email)
  let bodySnippet = ''
  if (!opfsMode) {
    try {
      const body = email.body || ''
      bodySnippet = body.slice(0, 200).replace(/\n/g, ' ')
    } catch { /* skip */ }
  }

  return {
    index,
    folderPath,
    subject,
    senderName,
    senderEmail,
    displayTo,
    displayCC,
    date: date ? date.toISOString() : null,
    hasAttachments: email.hasAttachments,
    importance: email.importance,
    isRead: email.isRead,
    numberOfAttachments: email.numberOfAttachments,
    attachmentNames,
    bodySnippet,
    _searchText: buildSearchText(subject, senderName, senderEmail, displayTo, displayCC, attachmentNames),
  }
}

function yieldToMessageLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function resetState() {
  pstFile = null
  pstBuffer = null
  fileRef = null
  clearChunkCache()
  currentFileName = ''
  currentFileSize = 0
  opfsMode = false
  folderCache.clear()
  emailCache.clear()
  completedFolders.clear()
  ++folderLoadOpId
  ++searchOpId
}

function initPSTLegacy(uint8: Uint8Array, fileName: string): FolderNode {
  restoreReadSync()
  opfsMode = false
  pstBuffer = Buffer.from(uint8.buffer as ArrayBuffer, uint8.byteOffset, uint8.byteLength)
  pstFile = new PSTFile(pstBuffer)
  currentFileName = fileName
  currentFileSize = uint8.byteLength
  folderCache.clear()
  emailCache.clear()

  return buildFolderTree(pstFile.getRootFolder())
}

function initPSTFromOPFS(fileName: string, fileSize: number): FolderNode {
  patchReadSync()
  opfsMode = true
  pstBuffer = null
  currentFileName = fileName
  currentFileSize = fileSize
  parseBytesRead = 0
  parseLastReportTime = 0
  parseProgressEnabled = true
  // PSTFile constructor reads 514 bytes via readSync immediately
  // Passing a 1-byte buffer — readSync is patched so it doesn't use pstBuffer
  pstFile = new PSTFile(Buffer.alloc(1))
  folderCache.clear()
  emailCache.clear()

  const tree = buildFolderTree(pstFile.getRootFolder())
  parseProgressEnabled = false
  return tree
}

function initPSTFromFile(file: File): FolderNode {
  fileRef = file
  clearChunkCache()
  patchReadSyncFile()
  opfsMode = true // skip per-email body snippets (FileReaderSync I/O is slow)
  pstBuffer = null
  currentFileName = file.name
  currentFileSize = file.size
  parseBytesRead = 0
  parseLastReportTime = 0
  parseProgressEnabled = true
  pstFile = new PSTFile(Buffer.alloc(1))
  folderCache.clear()
  emailCache.clear()

  const tree = buildFolderTree(pstFile.getRootFolder())
  parseProgressEnabled = false
  return tree
}

// ─── OPFS file operations ───────────────────────────────────────────────────

async function getOpfsHandle(create: boolean): Promise<FileSystemFileHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getFileHandle('current.pst', { create })
  } catch {
    return null
  }
}

async function closeSyncHandle() {
  if (syncHandle) {
    try { syncHandle.close() } catch { /* ignore */ }
    syncHandle = null
  }
}

async function deleteOpfsFile() {
  await closeSyncHandle()
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry('current.pst')
  } catch { /* file may not exist */ }
}

// ─── EML builder helpers (RFC 5322, 2045-2049, 2047, 2231) ─────────────────

/** Strip CR/LF to prevent header injection (RFC 5322 §2.2) */
function sanitizeHeaderValue(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

/** Sanitize email address — only printable ASCII, no angle brackets or CR/LF */
function sanitizeEmail(email: string): string {
  return email.replace(/[\r\n<>]/g, '').replace(/[^\x21-\x7e]/g, '').trim()
}

/**
 * RFC 2047 encoded-word encoding with splitting.
 * Each encoded-word MUST be <=75 chars (RFC 2047 §2).
 * For base64: =?UTF-8?B?...?= overhead is 12 chars, leaving 63 for payload.
 * 63 base64 chars = 47 raw bytes. We split on UTF-8 char boundaries.
 */
function encodeRfc2047(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const bytes = Buffer.from(text, 'utf-8')
  // 63 base64 chars → 47 bytes input (floor(63*3/4)=47)
  const chunkSize = 45 // conservative to stay under 75 with overhead
  const words: string[] = []
  for (let offset = 0; offset < bytes.length;) {
    // Find a clean UTF-8 boundary at or before offset+chunkSize
    let end = Math.min(offset + chunkSize, bytes.length)
    // Don't split in the middle of a multi-byte UTF-8 sequence
    if (end < bytes.length) {
      while (end > offset && (bytes[end] & 0xC0) === 0x80) end--
    }
    if (end === offset) end = Math.min(offset + chunkSize, bytes.length) // fallback
    const chunk = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset + offset, end - offset)
    words.push(`=?UTF-8?B?${chunk.toString('base64')}?=`)
    offset = end
  }
  return words.join('\r\n ')
}

/**
 * Fold a header line to comply with RFC 5322 §2.1.1:
 * - MUST NOT exceed 998 chars per line
 * - SHOULD NOT exceed 78 chars per line
 * Folds at commas (address lists), spaces, or forces a break at 998.
 */
function foldHeader(header: string): string {
  if (header.length <= 78) return header
  const colonIdx = header.indexOf(': ')
  if (colonIdx < 0) return header
  const name = header.slice(0, colonIdx + 2)
  const value = header.slice(colonIdx + 2)

  // Already contains encoded-word folding? Leave as-is.
  if (value.includes('\r\n ')) return header

  const lines: string[] = []
  let current = name
  // Split on comma-space (address lists) or spaces
  const tokens = value.split(/(?<=, )|(?<= )/g)

  for (const token of tokens) {
    if (current.length + token.length > 76 && current.length > name.length) {
      lines.push(current)
      current = ' ' + token // continuation line starts with space (RFC 5322 §2.2.3)
    } else {
      current += token
    }
  }
  if (current.trim()) lines.push(current)

  // Hard-break any remaining lines >998 chars (MUST limit)
  const result: string[] = []
  for (const line of lines) {
    if (line.length <= 998) {
      result.push(line)
    } else {
      for (let i = 0; i < line.length; i += 998) {
        result.push((i > 0 ? ' ' : '') + line.slice(i, i + 998))
      }
    }
  }
  return result.join('\r\n')
}

/**
 * RFC 2231 parameter value encoding for Content-Type/Content-Disposition.
 * Returns { simple, extended } where:
 * - simple: quoted ASCII fallback filename for old clients
 * - extended: RFC 2231 UTF-8 percent-encoded filename* for modern clients
 * When the name is pure ASCII, extended is null.
 */
function encodeFilenameParams(name: string): { simple: string; extended: string | null } {
  // Sanitize for header safety
  const clean = sanitizeHeaderValue(name)
  // ASCII-safe fallback: strip non-ASCII, replace quotes
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  const simple = `"${ascii}"`

  // If pure ASCII and no special chars, no need for extended
  if (/^[\x20-\x7e]*$/.test(clean) && !clean.includes('"') && !clean.includes('\\')) {
    return { simple: `"${clean}"`, extended: null }
  }

  // RFC 2231 percent-encoding
  const encoded = Array.from(new TextEncoder().encode(clean))
    .map(b => {
      const c = String.fromCharCode(b)
      if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(c)) return c
      return '%' + b.toString(16).toUpperCase().padStart(2, '0')
    })
    .join('')

  return { simple, extended: `UTF-8''${encoded}` }
}

function formatRfc2822Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const d = days[date.getUTCDay()]
  const day = date.getUTCDate()
  const mon = months[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  const h = String(date.getUTCHours()).padStart(2, '0')
  const m = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${d}, ${day} ${mon} ${year} ${h}:${m}:${s} +0000`
}

/** RFC 2045 §6.8: base64 content-transfer-encoding, 76-char lines */
function base64EncodeMime(buf: Buffer): string {
  const raw = buf.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < raw.length; i += 76) {
    lines.push(raw.slice(i, i + 76))
  }
  return lines.join('\r\n')
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.+$/, '').trim() || 'unnamed'
}

/** RFC 2046 §5.1.1: boundary max 70 chars, no trailing space */
function generateBoundary(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = '----=_Part_'
  for (let i = 0; i < 24; i++) result += chars[Math.floor(Math.random() * chars.length)]
  return result
}

function buildEml(msg: PSTMessage, options: ExportOptions): Uint8Array {
  const boundary = generateBoundary()
  const altBoundary = generateBoundary()

  // Collect body parts
  const htmlBody = options.includeHTML ? (msg.bodyHTML || '') : ''
  const txtBody = options.includeTXT ? (msg.body || '') : ''

  // Collect attachments
  const attachments: Array<{ fileName: string; mimeType: string; data: Buffer }> = []
  if (options.includeAttachments) {
    for (let i = 0; i < msg.numberOfAttachments; i++) {
      try {
        const att = msg.getAttachment(i)
        const stream = att.fileInputStream
        if (!stream) continue
        const size = att.filesize > 0 ? att.filesize : att.size
        if (size <= 0) continue
        const buf = Buffer.alloc(size)
        stream.readCompletely(buf)
        const name = att.displayName || att.filename || `attachment_${i + 1}`
        const mime = att.mimeTag || 'application/octet-stream'
        attachments.push({ fileName: name, mimeType: mime, data: buf })
      } catch { /* skip broken attachment */ }
    }
  }

  const hasHtml = htmlBody.length > 0
  const hasTxt = txtBody.length > 0
  const hasAttachments = attachments.length > 0
  const hasMultipleBodies = hasHtml && hasTxt
  const needsMultipart = hasMultipleBodies || hasAttachments

  // ── Build headers (RFC 5322 + RFC 2047) ──────────────────────────────────

  const headers: string[] = []

  // From: display-name + addr-spec (RFC 5322 §3.4)
  const senderEmail = sanitizeEmail(msg.senderEmailAddress || '')
  const senderName = sanitizeHeaderValue(msg.senderName || '')
  if (senderEmail) {
    headers.push(foldHeader(`From: ${encodeRfc2047(senderName)} <${senderEmail}>`))
  } else {
    headers.push(`From: ${encodeRfc2047(senderName || 'Unknown')}`)
  }

  // To/CC: sanitize + fold long address lists (RFC 5322 §2.1.1)
  if (msg.displayTo) headers.push(foldHeader(`To: ${sanitizeHeaderValue(msg.displayTo)}`))
  if (msg.displayCC) headers.push(foldHeader(`CC: ${sanitizeHeaderValue(msg.displayCC)}`))

  // Subject: RFC 2047 encoded-words with auto-splitting
  headers.push(`Subject: ${encodeRfc2047(sanitizeHeaderValue(msg.subject || '(Kein Betreff)'))}`)

  // Date: RFC 2822 format
  const date = msg.clientSubmitTime || msg.messageDeliveryTime
  if (date) headers.push(`Date: ${formatRfc2822Date(date)}`)

  // Message-ID: preserve original or generate (RFC 5322 §3.6.4)
  const rawMsgId = msg.internetMessageId || ''
  const msgId = rawMsgId && rawMsgId.includes('@')
    ? sanitizeHeaderValue(rawMsgId)
    : `<generated-${Date.now()}-${Math.random().toString(36).slice(2)}@pst-export>`
  headers.push(`Message-ID: ${msgId}`)

  headers.push('MIME-Version: 1.0')

  // ── Build MIME body ──────────────────────────────────────────────────────

  const parts: string[] = []

  if (!needsMultipart) {
    // Single body part — no multipart wrapper needed
    if (hasHtml) {
      headers.push('Content-Type: text/html; charset="UTF-8"')
      headers.push('Content-Transfer-Encoding: base64')
      parts.push(headers.join('\r\n'))
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(htmlBody, 'utf-8')))
    } else if (hasTxt) {
      headers.push('Content-Type: text/plain; charset="UTF-8"')
      headers.push('Content-Transfer-Encoding: base64')
      parts.push(headers.join('\r\n'))
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(txtBody, 'utf-8')))
    } else {
      headers.push('Content-Type: text/plain; charset="UTF-8"')
      parts.push(headers.join('\r\n'))
      parts.push('')
    }
  } else {
    // Multipart message
    headers.push(`Content-Type: multipart/mixed;\r\n boundary="${boundary}"`)
    parts.push(headers.join('\r\n'))
    parts.push('')

    // Body section
    if (hasMultipleBodies) {
      // Wrap HTML+TXT in multipart/alternative (RFC 2046 §5.1.4)
      parts.push(`--${boundary}`)
      parts.push(`Content-Type: multipart/alternative;\r\n boundary="${altBoundary}"`)
      parts.push('')
      // TXT part (first = least preferred, per RFC 2046 §5.1.4)
      parts.push(`--${altBoundary}`)
      parts.push('Content-Type: text/plain; charset="UTF-8"')
      parts.push('Content-Transfer-Encoding: base64')
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(txtBody, 'utf-8')))
      parts.push('')
      // HTML part (last = most preferred)
      parts.push(`--${altBoundary}`)
      parts.push('Content-Type: text/html; charset="UTF-8"')
      parts.push('Content-Transfer-Encoding: base64')
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(htmlBody, 'utf-8')))
      parts.push('')
      parts.push(`--${altBoundary}--`)
    } else if (hasHtml) {
      parts.push(`--${boundary}`)
      parts.push('Content-Type: text/html; charset="UTF-8"')
      parts.push('Content-Transfer-Encoding: base64')
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(htmlBody, 'utf-8')))
    } else if (hasTxt) {
      parts.push(`--${boundary}`)
      parts.push('Content-Type: text/plain; charset="UTF-8"')
      parts.push('Content-Transfer-Encoding: base64')
      parts.push('')
      parts.push(base64EncodeMime(Buffer.from(txtBody, 'utf-8')))
    }

    // Attachment parts (RFC 2183 Content-Disposition + RFC 2231 filenames)
    for (const att of attachments) {
      parts.push('')
      parts.push(`--${boundary}`)
      const { simple, extended } = encodeFilenameParams(att.fileName)
      const mimeType = sanitizeHeaderValue(att.mimeType)
      // Content-Type: include both name= (legacy) and name*= (RFC 2231) when non-ASCII
      if (extended) {
        parts.push(`Content-Type: ${mimeType};\r\n name=${simple};\r\n name*=${extended}`)
      } else {
        parts.push(`Content-Type: ${mimeType}; name=${simple}`)
      }
      parts.push('Content-Transfer-Encoding: base64')
      // Content-Disposition: include both filename= and filename*= (RFC 2231 §4)
      if (extended) {
        parts.push(`Content-Disposition: attachment;\r\n filename=${simple};\r\n filename*=${extended}`)
      } else {
        parts.push(`Content-Disposition: attachment; filename=${simple}`)
      }
      parts.push('')
      parts.push(base64EncodeMime(att.data))
    }

    parts.push('')
    parts.push(`--${boundary}--`)
  }

  const emlString = parts.join('\r\n')
  return new TextEncoder().encode(emlString)
}

// ─── Message handler ─────────────────────────────────────────────────────────

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  if (transfer) {
    postMessage(msg, transfer)
  } else {
    postMessage(msg)
  }
}

self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data
  try {
    switch (cmd.type) {
      case 'LOAD_FILE': {
        const myOpId = ++loadOpId
        const file = cmd.file

        // Close any existing handle first
        await closeSyncHandle()
        resetState()

        // Probe OPFS availability (APIs exist on file:// but fail at runtime)
        const opfsOk = await probeOpfs()

        if (!opfsOk) {
          // No OPFS (e.g. file:// URL) — lazy random-access via FileReaderSync
          post({ type: 'PROGRESS', message: 'PST wird verarbeitet...', phase: 'parse' })
          const tree = initPSTFromFile(file)
          if (loadOpId !== myOpId) return
          post({ type: 'READY', tree, fileName: file.name, fileSize: file.size, savedAt: 0 })
          return
        }

        // Check storage capacity
        const capacity = await checkStorageCapacity(file.size)
        if (!capacity.ok) {
          post({
            type: 'ERROR',
            message: `Nicht genügend Speicher verfügbar. Benötigt: ${formatBytes(Math.ceil(file.size * 1.1 + 50_000_000))}, Verfügbar: ${formatBytes(capacity.available)}.`,
          })
          return
        }

        // Request persistent storage
        try { await navigator.storage.persist() } catch { /* non-critical */ }

        // Stream file to OPFS
        post({ type: 'PROGRESS', message: 'Datei wird in lokalen Cache kopiert...', percent: 0, phase: 'copy' })
        const fileHandle = await getOpfsHandle(true)
        if (!fileHandle) {
          post({ type: 'ERROR', message: 'OPFS-Dateizugriff fehlgeschlagen.' })
          return
        }

        syncHandle = await fileHandle.createSyncAccessHandle()
        syncHandle.truncate(0)

        const reader = file.stream().getReader()
        let offset = 0
        const totalSize = file.size
        let lastProgressTime = 0

        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (loadOpId !== myOpId) {
              // Aborted by a newer load
              reader.cancel().catch(() => {})
              await closeSyncHandle()
              return
            }
            syncHandle.write(value, { at: offset })
            offset += value.byteLength
            const now = performance.now()
            if (now - lastProgressTime >= 2000) {
              lastProgressTime = now
              const percent = Math.round(offset / totalSize * 100)
              post({
                type: 'PROGRESS',
                message: `Datei wird in lokalen Cache kopiert... (${formatBytes(offset)} / ${formatBytes(totalSize)})`,
                percent,
                phase: 'copy',
              })
              // Yield to macrotask queue so ABORT_LOAD messages can be processed
              await yieldToMessageLoop()
              if (loadOpId !== myOpId) {
                reader.cancel().catch(() => {})
                await closeSyncHandle()
                return
              }
            }
          }

          syncHandle.flush()
        } catch (err) {
          reader.cancel().catch(() => {})
          await closeSyncHandle()
          post({ type: 'ERROR', message: `Fehler beim Kopieren der Datei: ${err instanceof Error ? err.message : String(err)}` })
          return
        }

        if (loadOpId !== myOpId) {
          await closeSyncHandle()
          return
        }

        // Parse PST from OPFS
        post({ type: 'PROGRESS', message: 'PST wird verarbeitet...', percent: 100, phase: 'parse' })
        const tree = initPSTFromOPFS(file.name, file.size)

        // Save metadata to IDB (NOT the file data)
        let savedAt = 0
        try {
          savedAt = await saveMetadataToIDB(file.name, file.size)
        } catch { /* non-critical */ }

        post({ type: 'READY', tree, fileName: file.name, fileSize: file.size, savedAt })
        break
      }

      case 'LOAD_BUFFER': {
        // Legacy path — kept for small files / non-OPFS browsers
        post({ type: 'PROGRESS', message: 'PST wird verarbeitet...', phase: 'parse' })
        const tree = initPSTLegacy(new Uint8Array(cmd.buffer), cmd.fileName)
        post({ type: 'READY', tree, fileName: currentFileName, fileSize: currentFileSize, savedAt: 0 })
        break
      }

      case 'LOAD_CACHED': {
        const myOpId = ++loadOpId
        post({ type: 'PROGRESS', message: 'Gespeicherte Datei wird geladen...' })

        // Load metadata from IDB
        const meta = await loadMetadataFromIDB()
        if (!meta) {
          // No cached data — signal "no cache" (empty message = not a user-visible error)
          post({ type: 'ERROR', message: '' })
          return
        }
        if (loadOpId !== myOpId) return // aborted by LOAD_FILE or DELETE_CACHE

        // Probe OPFS availability
        if (!(await probeOpfs())) {
          // Can't use OPFS cache without OPFS support (e.g. file:// URL)
          post({ type: 'ERROR', message: '' })
          return
        }
        if (loadOpId !== myOpId) return

        // Try to open cached OPFS file
        const fileHandle = await getOpfsHandle(false)
        if (!fileHandle) {
          // OPFS file doesn't exist — cache invalid
          await clearMetadataFromIDB()
          post({ type: 'ERROR', message: '' })
          return
        }

        try {
          syncHandle = await fileHandle.createSyncAccessHandle()
        } catch {
          await clearMetadataFromIDB()
          post({ type: 'ERROR', message: '' })
          return
        }
        if (loadOpId !== myOpId) {
          await closeSyncHandle()
          return
        }

        // Verify file size matches
        const actualSize = syncHandle.getSize()
        if (actualSize !== meta.fileSize) {
          // Cache inconsistent — self-heal: discard silently
          await closeSyncHandle()
          await deleteOpfsFile()
          await clearMetadataFromIDB()
          post({ type: 'ERROR', message: '' })
          return
        }

        post({ type: 'PROGRESS', message: 'PST wird verarbeitet...', phase: 'parse' })
        try {
          const tree = initPSTFromOPFS(meta.fileName, meta.fileSize)
          post({ type: 'READY', tree, fileName: meta.fileName, fileSize: meta.fileSize, savedAt: meta.savedAt })
        } catch {
          // Parse failed — self-heal: discard broken cache silently
          await closeSyncHandle()
          await deleteOpfsFile()
          await clearMetadataFromIDB()
          resetState()
          post({ type: 'ERROR', message: '' })
        }
        break
      }

      case 'ABORT_LOAD': {
        ++loadOpId // cancel any in-flight LOAD_FILE/LOAD_CACHED
        resetState()
        post({ type: 'ERROR', message: '' }) // silent reset
        break
      }

      case 'ABORT_SEARCH': {
        ++searchOpId
        break
      }

      case 'DELETE_CACHE': {
        ++loadOpId // cancel any in-flight LOAD_FILE/LOAD_CACHED
        await closeSyncHandle()
        await deleteOpfsFile()
        await clearMetadataFromIDB()
        resetState()
        post({ type: 'CACHE_DELETED' })
        break
      }

      case 'FETCH_FOLDER': {
        // Every FETCH_FOLDER gets a unique opId — cancels any in-progress load
        const myFolderOpId = ++folderLoadOpId

        // Check if fully cached
        if (completedFolders.has(cmd.path)) {
          const cached = emailCache.get(cmd.path)!
          // Paginate cache hits to avoid large structured-clone spikes
          for (let page = 0; page * PAGE_SIZE < cached.length; page++) {
            const slice = cached.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
            post({ type: 'FOLDER_EMAILS', path: cmd.path, emails: slice, searchableFolderCount: emailCache.size, totalCount: cached.length, page })
            if (cached.length > PAGE_SIZE && page * PAGE_SIZE + PAGE_SIZE < cached.length) {
              await yieldToMessageLoop()
              if (folderLoadOpId !== myFolderOpId) return
            }
          }
          post({ type: 'FOLDER_DONE', path: cmd.path, totalCount: cached.length })
          return
        }

        const folder = folderCache.get(cmd.path)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${cmd.path}` })
          return
        }

        const totalCount = folder.contentCount

        // Small folder: load all at once (original behavior)
        if (totalCount < PAGINATION_THRESHOLD) {
          const emails: EmailMeta[] = []
          try {
            folder.moveChildCursorTo(0)
            let email: PSTMessage | null = folder.getNextChild()
            let idx = 0
            while (email != null) {
              try {
                emails.push(extractEmailMeta(email, idx, cmd.path))
              } catch { /* skip broken email */ }
              email = folder.getNextChild()
              idx++
            }
          } catch (err) {
            if (emails.length === 0) {
              post({ type: 'ERROR', message: `Fehler beim Lesen des Ordners: ${err instanceof Error ? err.message : String(err)}` })
              return
            }
            // Partial read — continue with what we have
          }

          emailCache.set(cmd.path, emails)
          completedFolders.add(cmd.path)
          post({ type: 'FOLDER_EMAILS', path: cmd.path, emails, searchableFolderCount: emailCache.size, totalCount: emails.length, page: 0 })
          post({ type: 'FOLDER_DONE', path: cmd.path, totalCount: emails.length })
          return
        }

        // Large folder: paginated loading
        // Discard partial cache from a previously cancelled load of this folder
        emailCache.delete(cmd.path)

        const emails: EmailMeta[] = []
        emailCache.set(cmd.path, emails)
        let pageStart = 0
        let page = 0

        try {
          folder.moveChildCursorTo(0)
          let email: PSTMessage | null = folder.getNextChild()
          let idx = 0

          while (email != null) {
            try {
              emails.push(extractEmailMeta(email, idx, cmd.path))
            } catch { /* skip broken email */ }
            idx++

            // Determine page boundary: first page is smaller for fast initial display
            const currentPageSize = page === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE
            if (emails.length - pageStart >= currentPageSize) {
              post({ type: 'FOLDER_EMAILS', path: cmd.path, emails: emails.slice(pageStart, pageStart + currentPageSize), searchableFolderCount: emailCache.size, totalCount, page })
              pageStart += currentPageSize
              page++

              // Yield to allow message processing (cancellation check)
              await yieldToMessageLoop()
              if (folderLoadOpId !== myFolderOpId) return // cancelled
            }

            email = folder.getNextChild()
          }

          // Send remaining emails (partial last page)
          if (emails.length > pageStart) {
            post({ type: 'FOLDER_EMAILS', path: cmd.path, emails: emails.slice(pageStart), searchableFolderCount: emailCache.size, totalCount, page })
          }
        } catch (err) {
          if (emails.length === 0) {
            post({ type: 'ERROR', message: `Fehler beim Lesen des Ordners: ${err instanceof Error ? err.message : String(err)}` })
            return
          }
          // Partial read — continue with what we have
        }

        // Only mark complete + send DONE if not cancelled
        if (folderLoadOpId !== myFolderOpId) return
        completedFolders.add(cmd.path)
        post({ type: 'FOLDER_DONE', path: cmd.path, totalCount: emails.length })
        break
      }

      case 'FETCH_BODY': {
        const folder = folderCache.get(cmd.folderPath)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${cmd.folderPath}` })
          return
        }

        try {
          folder.moveChildCursorTo(cmd.index)
          const email = folder.getNextChild()
          if (email) {
            post({
              type: 'EMAIL_BODY',
              folderPath: cmd.folderPath,
              index: cmd.index,
              body: email.body || '',
              bodyHTML: email.bodyHTML || '',
            })
          } else {
            post({ type: 'ERROR', message: 'E-Mail nicht gefunden' })
          }
        } catch (err: unknown) {
          post({ type: 'ERROR', message: `Fehler beim Laden: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }

      case 'FETCH_ATTACHMENT': {
        const folder = folderCache.get(cmd.folderPath)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${cmd.folderPath}` })
          return
        }

        try {
          folder.moveChildCursorTo(cmd.index)
          const msg = folder.getNextChild()
          if (!msg) {
            post({ type: 'ERROR', message: 'E-Mail nicht gefunden' })
            return
          }

          const att = msg.getAttachment(cmd.attachmentIndex)
          if (!att) {
            post({ type: 'ERROR', message: 'Anhang nicht gefunden' })
            return
          }

          const size = att.attachSize
          const buf = Buffer.alloc(size)
          const stream = att.fileInputStream
          if (stream) {
            stream.readCompletely(buf)
          }
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
          const fileName = att.displayName || att.filename || `attachment_${cmd.attachmentIndex}`
          const mimeType = att.mimeTag || 'application/octet-stream'
          post({ type: 'ATTACHMENT_DATA', fileName, mimeType, data: ab }, [ab])
        } catch (err: unknown) {
          post({ type: 'ERROR', message: `Fehler beim Laden des Anhangs: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }

      case 'BUILD_EML': {
        const folder = folderCache.get(cmd.folderPath)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${cmd.folderPath}` })
          return
        }

        try {
          folder.moveChildCursorTo(cmd.index)
          const msg = folder.getNextChild()
          if (!msg) {
            post({ type: 'ERROR', message: 'E-Mail nicht gefunden' })
            return
          }

          const emlData = buildEml(msg, { includeHTML: true, includeTXT: true, includeAttachments: true })
          const subject = sanitizeFileName(msg.subject || 'Kein Betreff').slice(0, 80)
          const fileName = `${subject}.eml`
          const ab = emlData.buffer.slice(emlData.byteOffset, emlData.byteOffset + emlData.byteLength) as ArrayBuffer
          post({ type: 'EML_READY', data: ab, fileName }, [ab])
        } catch (err: unknown) {
          post({ type: 'ERROR', message: `Fehler beim Erstellen der EML: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }

      case 'SEARCH': {
        const mySearchOpId = ++searchOpId
        // Cancel in-flight paginated folder loads to avoid cursor interference
        ++folderLoadOpId

        const folder = folderCache.get(cmd.folderPath)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${cmd.folderPath}` })
          return
        }

        const trimmed = cmd.query.trim().toLowerCase()
        const total = Math.max(0, folder.contentCount)
        if (!trimmed) {
          post({ type: 'SEARCH_RESULTS', requestId: cmd.requestId, results: [], append: false })
          post({
            type: 'SEARCH_PROGRESS',
            progress: {
              requestId: cmd.requestId,
              folderPath: cmd.folderPath,
              scanned: 0,
              total,
              matches: 0,
              done: true,
            },
          })
          return
        }

        const terms = trimmed.split(/\s+/).filter(Boolean)
        const cachedEmails = emailCache.get(cmd.folderPath)
        let scanned = 0
        let matches = 0
        let page: SearchResult[] = []
        let lastProgressAt = performance.now()
        let lastYieldAt = performance.now()

        post({ type: 'SEARCH_RESULTS', requestId: cmd.requestId, results: [], append: false })
        post({
          type: 'SEARCH_PROGRESS',
          progress: {
            requestId: cmd.requestId,
            folderPath: cmd.folderPath,
            scanned: 0,
            total,
            matches: 0,
            done: false,
          },
        })

        try {
          folder.moveChildCursorTo(0)
          let msg: PSTMessage | null = folder.getNextChild()
          let idx = 0

          while (msg != null) {
            if (searchOpId !== mySearchOpId) {
              post({
                type: 'SEARCH_PROGRESS',
                progress: {
                  requestId: cmd.requestId,
                  folderPath: cmd.folderPath,
                  scanned,
                  total,
                  matches,
                  done: true,
                  cancelled: true,
                },
              })
              return
            }

            const cachedMeta = cachedEmails?.[idx]
            const email = cachedMeta ?? extractEmailMeta(msg, idx, cmd.folderPath)
            const metaSearchText = email._searchText

            let bodyLower = ''
            let bodyRaw = ''
            let allMatch = true
            for (const t of terms) {
              if (metaSearchText.includes(t)) continue
              if (!bodyLower) {
                try {
                  bodyRaw = msg.body || ''
                  bodyLower = bodyRaw.toLowerCase()
                } catch {
                  bodyRaw = ''
                  bodyLower = ''
                }
              }
              if (!bodyLower.includes(t)) {
                allMatch = false
                break
              }
            }

            if (allMatch) {
              const enrichedEmail = (!email.bodySnippet && bodyRaw)
                ? { ...email, bodySnippet: buildBodySnippet(bodyRaw, terms) }
                : email
              const matchField = detectMatchField(enrichedEmail, terms, bodyLower)
              page.push({ email: enrichedEmail, folderPath: enrichedEmail.folderPath, matchField })
              matches++

              if (page.length >= SEARCH_RESULT_PAGE_SIZE) {
                post({ type: 'SEARCH_RESULTS', requestId: cmd.requestId, results: page, append: true })
                page = []
              }
            }

            scanned++
            idx++

            const now = performance.now()
            if (now - lastProgressAt >= SEARCH_PROGRESS_INTERVAL) {
              lastProgressAt = now
              post({
                type: 'SEARCH_PROGRESS',
                progress: {
                  requestId: cmd.requestId,
                  folderPath: cmd.folderPath,
                  scanned,
                  total,
                  matches,
                  done: false,
                },
              })
            }

            if (now - lastYieldAt >= SEARCH_YIELD_INTERVAL) {
              lastYieldAt = now
              await yieldToMessageLoop()
              if (searchOpId !== mySearchOpId) {
                post({
                  type: 'SEARCH_PROGRESS',
                  progress: {
                    requestId: cmd.requestId,
                    folderPath: cmd.folderPath,
                    scanned,
                    total,
                    matches,
                    done: true,
                    cancelled: true,
                  },
                })
                return
              }
            }

            msg = folder.getNextChild()
          }
        } catch (err) {
          if (scanned === 0) {
            post({ type: 'ERROR', message: `Fehler bei der Suche: ${err instanceof Error ? err.message : String(err)}` })
            post({
              type: 'SEARCH_PROGRESS',
              progress: {
                requestId: cmd.requestId,
                folderPath: cmd.folderPath,
                scanned: 0,
                total,
                matches: 0,
                done: true,
              },
            })
            return
          }
          // Partial results are still useful
        }

        if (searchOpId !== mySearchOpId) {
          post({
            type: 'SEARCH_PROGRESS',
            progress: {
              requestId: cmd.requestId,
              folderPath: cmd.folderPath,
              scanned,
              total,
              matches,
              done: true,
              cancelled: true,
            },
          })
          return
        }

        if (page.length > 0) {
          post({ type: 'SEARCH_RESULTS', requestId: cmd.requestId, results: page, append: true })
        }

        post({
          type: 'SEARCH_PROGRESS',
          progress: {
            requestId: cmd.requestId,
            folderPath: cmd.folderPath,
            scanned,
            total,
            matches,
            done: true,
          },
        })
        break
      }

      case 'EXPORT_EMAILS': {
        const myOpId = ++loadOpId
        const { emails: emailRefs, options } = cmd
        const total = emailRefs.length

        if (total === 0) {
          post({ type: 'ERROR', message: 'Keine E-Mails zum Exportieren.' })
          return
        }

        post({ type: 'PROGRESS', message: `Export wird vorbereitet... (0 / ${total})` })

        const files: Record<string, Uint8Array> = {}
        const usedNames = new Map<string, number>()

        for (let i = 0; i < total; i++) {
          if (loadOpId !== myOpId) return // aborted

          const ref = emailRefs[i]
          const folder = folderCache.get(ref.folderPath)
          if (!folder) continue

          try {
            folder.moveChildCursorTo(ref.index)
            const msg = folder.getNextChild()
            if (!msg) continue

            const emlData = buildEml(msg, options)

            // Build deduplicated filename
            const date = msg.clientSubmitTime || msg.messageDeliveryTime
            const datePrefix = date
              ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
              : 'undatiert'
            const subject = sanitizeFileName(msg.subject || 'Kein Betreff').slice(0, 80)
            const baseName = `${datePrefix} ${subject}`
            const count = usedNames.get(baseName) || 0
            usedNames.set(baseName, count + 1)
            const fileName = count > 0 ? `${baseName} (${count + 1}).eml` : `${baseName}.eml`

            files[fileName] = emlData
          } catch { /* skip broken email */ }

          // Progress every 10 emails
          if ((i + 1) % 10 === 0 || i === total - 1) {
            post({ type: 'PROGRESS', message: `E-Mails werden exportiert... (${i + 1} / ${total})` })
            await yieldToMessageLoop()
            if (loadOpId !== myOpId) return
          }
        }

        if (loadOpId !== myOpId) return

        post({ type: 'PROGRESS', message: 'ZIP wird erstellt...' })
        await yieldToMessageLoop()
        if (loadOpId !== myOpId) return

        try {
          const zipData = zipSync(files)
          const zipBuffer = zipData.buffer.slice(zipData.byteOffset, zipData.byteOffset + zipData.byteLength) as ArrayBuffer
          const exportFileName = `PST-Export_${new Date().toISOString().slice(0, 10)}.zip`
          post({ type: 'EXPORT_READY', zipBuffer, fileName: exportFileName })
        } catch (err) {
          post({ type: 'ERROR', message: `ZIP-Erstellung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }

      case 'EXPORT_FOLDER': {
        const myOpId = ++loadOpId
        const { folderPath, options } = cmd

        const folder = folderCache.get(folderPath)
        if (!folder) {
          post({ type: 'ERROR', message: `Ordner nicht gefunden: ${folderPath}` })
          return
        }

        const totalCount = folder.contentCount
        if (totalCount === 0) {
          post({ type: 'ERROR', message: 'Keine E-Mails zum Exportieren.' })
          return
        }

        post({ type: 'PROGRESS', message: `Export wird vorbereitet... (0 / ${totalCount})` })

        const files: Record<string, Uint8Array> = {}
        const usedNames = new Map<string, number>()

        try {
          folder.moveChildCursorTo(0)
          let msg: PSTMessage | null = folder.getNextChild()
          let idx = 0

          while (msg != null) {
            if (loadOpId !== myOpId) return // aborted

            try {
              const emlData = buildEml(msg, options)

              const date = msg.clientSubmitTime || msg.messageDeliveryTime
              const datePrefix = date
                ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                : 'undatiert'
              const subject = sanitizeFileName(msg.subject || 'Kein Betreff').slice(0, 80)
              const baseName = `${datePrefix} ${subject}`
              const count = usedNames.get(baseName) || 0
              usedNames.set(baseName, count + 1)
              const fileName = count > 0 ? `${baseName} (${count + 1}).eml` : `${baseName}.eml`

              files[fileName] = emlData
            } catch { /* skip broken email */ }

            idx++
            if (idx % 10 === 0 || idx === totalCount) {
              post({ type: 'PROGRESS', message: `E-Mails werden exportiert... (${idx} / ${totalCount})` })
              await yieldToMessageLoop()
              if (loadOpId !== myOpId) return
            }

            msg = folder.getNextChild()
          }
        } catch (err) {
          if (Object.keys(files).length === 0) {
            post({ type: 'ERROR', message: `Fehler beim Lesen des Ordners: ${err instanceof Error ? err.message : String(err)}` })
            return
          }
          // Partial read — export what we have
        }

        if (loadOpId !== myOpId) return

        post({ type: 'PROGRESS', message: 'ZIP wird erstellt...' })
        await yieldToMessageLoop()
        if (loadOpId !== myOpId) return

        try {
          const zipData = zipSync(files)
          const zipBuffer = zipData.buffer.slice(zipData.byteOffset, zipData.byteOffset + zipData.byteLength) as ArrayBuffer
          const folderName = sanitizeFileName(folderPath.split(' / ').pop() || 'Ordner')
          const exportFileName = `${folderName}_${new Date().toISOString().slice(0, 10)}.zip`
          post({ type: 'EXPORT_READY', zipBuffer, fileName: exportFileName })
        } catch (err) {
          post({ type: 'ERROR', message: `ZIP-Erstellung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }
    }
  } catch (err: unknown) {
    post({ type: 'ERROR', message: err instanceof Error ? err.message : 'Worker-Fehler' })
  }
}
