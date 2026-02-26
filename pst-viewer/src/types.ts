// ─── Shared types for main thread ↔ worker communication ─────────────────────

/** Email metadata without body/bodyHTML — used in email list */
export interface EmailMeta {
  index: number
  folderPath: string
  subject: string
  senderName: string
  senderEmail: string
  displayTo: string
  displayCC: string
  /** ISO string or null (Date objects don't survive structured clone reliably) */
  date: string | null
  hasAttachments: boolean
  importance: number
  isRead: boolean
  numberOfAttachments: number
  attachmentNames: string[]
  bodySnippet: string
  _searchText: string
}

/** Folder tree structure — no emails, just metadata */
export interface FolderNode {
  name: string
  emailCount: number
  subFolderCount: number
  children: FolderNode[]
  path: string
}

/** Search result referencing an email by location */
export interface SearchResult {
  email: EmailMeta
  folderPath: string
  matchField: string
}

export interface SearchProgress {
  requestId: number
  folderPath: string
  scanned: number
  total: number
  matches: number
  done: boolean
  cancelled?: boolean
}

/** Export options for EML/ZIP export */
export interface ExportOptions {
  includeHTML: boolean
  includeTXT: boolean
  includeAttachments: boolean
}

// ─── Worker commands (main → worker) ─────────────────────────────────────────

export type WorkerCommand =
  | { type: 'LOAD_FILE'; file: File; preferCache?: boolean }
  | { type: 'LOAD_BUFFER'; buffer: ArrayBuffer; fileName: string }
  | { type: 'LOAD_CACHED' }
  | { type: 'DELETE_CACHE' }
  | { type: 'FETCH_FOLDER'; path: string }
  | { type: 'FETCH_BODY'; folderPath: string; index: number }
  | { type: 'SEARCH'; query: string; folderPath: string; requestId: number }
  | { type: 'ABORT_SEARCH' }
  | { type: 'EXPORT_EMAILS'; emails: Array<{ folderPath: string; index: number }>; options: ExportOptions }
  | { type: 'FETCH_ATTACHMENT'; folderPath: string; index: number; attachmentIndex: number }
  | { type: 'EXPORT_FOLDER'; folderPath: string; options: ExportOptions }
  | { type: 'BUILD_EML'; folderPath: string; index: number }
  | { type: 'ABORT_LOAD' }

// ─── Worker responses (worker → main) ────────────────────────────────────────

export type WorkerResponse =
  | { type: 'READY'; tree: FolderNode; fileName: string; fileSize: number; savedAt: number }
  | { type: 'FOLDER_EMAILS'; path: string; emails: EmailMeta[]; searchableFolderCount: number; totalCount: number; page: number }
  | { type: 'FOLDER_DONE'; path: string; totalCount: number }
  | { type: 'EMAIL_BODY'; folderPath: string; index: number; body: string; bodyHTML: string }
  | { type: 'SEARCH_RESULTS'; requestId: number; results: SearchResult[]; append: boolean }
  | { type: 'SEARCH_PROGRESS'; progress: SearchProgress }
  | { type: 'PROGRESS'; message: string; percent?: number; phase?: 'copy' | 'parse' }
  | { type: 'ERROR'; message: string }
  | { type: 'EXPORT_READY'; zipBuffer: ArrayBuffer; fileName: string }
  | { type: 'ATTACHMENT_DATA'; fileName: string; mimeType: string; data: ArrayBuffer }
  | { type: 'EML_READY'; data: ArrayBuffer; fileName: string }
  | { type: 'CACHE_DELETED' }
