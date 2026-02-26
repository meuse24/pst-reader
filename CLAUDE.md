# PST Viewer

Browser-basierter Outlook PST-Datei-Viewer. Einzelne HTML-Datei, kein Server, alle Daten lokal.

## Tech Stack

- **UI**: React 19 + TypeScript 5.9 (strict)
- **Styling**: Tailwind CSS 4 (Vite Plugin)
- **Build**: Vite 7 + `vite-plugin-singlefile` (Ausgabe: eine `index.html`)
- **PST-Parsing**: `pst-extractor` (Node-Polyfills: buffer, browserify-zlib, stream-browserify, util, assert, events)
- **Virtualisierung**: `@tanstack/react-virtual`
- **ZIP-Export**: `fflate` (minimaler ZIP-Encoder, ~8KB gzipped, Worker-kompatibel)
- **Sprache**: Deutsch (UI-Texte, Datumsformate `de-DE`)

## Projektstruktur

```
pst-viewer/
  src/
    types.ts              # Shared Types (EmailMeta, FolderNode, WorkerCommand/Response)
    pstWorker.ts          # Web Worker: PST-Parsing, IndexedDB, Lazy-Loading
    usePSTWorker.ts       # React Hook: Worker-Lifecycle + State
    VirtualEmailList.tsx  # Virtualisierte E-Mail-Liste
    App.tsx               # Haupt-UI (MenuBar, FolderTree, Detail-Ansicht, ExportDialog, HelpDialog, InfoDialog)
    main.tsx              # Entry Point
    fs-shim.ts            # Leerer fs-Shim fuer pst-extractor im Browser
    index.css             # Tailwind Import
  vite.config.ts          # Vite Config mit Worker-Inline + Node-Polyfills
  index.html              # HTML Template
pst-viewer.html           # Build-Ausgabe (Kopie von dist/index.html)
```

## Architektur

### Web Worker (`pstWorker.ts`)
Alle schwere Arbeit laeuft im Worker-Thread:
- **Zero-Copy Buffer**: `Buffer.from(uint8.buffer, offset, length)` statt Kopie
- **PSTUtil.arraycopy Monkey-Patch**: `dest.set(src.subarray(...))` statt byte-by-byte
- **Lazy Folder Loading**: E-Mails eines Ordners werden erst bei Klick geladen (nur Metadaten, kein Body)
- **Paginiertes Ordner-Laden**: Ordner mit 500+ Mails werden seitenweise geladen (erste Seite 50, danach 200 Mails/Seite). Monotoner `folderLoadOpId`-Counter pro Request + `yieldToMessageLoop()` ermoeglichen Race-freien Abbruch bei Ordnerwechsel (auch A→B→A). Cache-Hits werden ebenfalls paginiert zurueckgesendet (kein 50k-Structured-Clone-Spike). Kleine Ordner (<500) laden weiterhin alles auf einmal.
- **Lazy Body Loading**: `moveChildCursorTo(index)` + `getNextChild()` laedt Body nur fuer ausgewaehlte Mail
- **IndexedDB**: Komplett im Worker (Load/Save/Delete)
- **Suche**: Durchsucht `emailCache` (alle besuchten Ordner), nur Metafelder — waechst inkrementell bei paginiertem Laden
- **EML-Export**: Suchergebnisse oder ganze Ordner als EML-Dateien in ZIP exportieren. RFC-konformer EML-Builder:
  - RFC 2047 Encoded-Word Splitting (max 75 Zeichen pro Wort, UTF-8-Zeichengrenzen)
  - RFC 5322 Header Folding (SHOULD 78, MUST 998 Zeichen pro Zeile)
  - RFC 2231 Filename-Encoding mit Dual-Filename (`filename=` ASCII-Fallback + `filename*=` UTF-8)
  - RFC 2822 Datums-Format, Header-Injection-Schutz (CR/LF-Sanitizing)
  - ZIP via `fflate` (zipSync). Fortschritt alle 10 Mails, Abbruch via `loadOpId`.
  - Warnung bei grossen Exporten (>=1000 Mails oder >=500 Mails mit Anhaengen)

### Worker-Kommunikation (`types.ts`)
Typisierte Messages:
- **Commands** (Main -> Worker): `LOAD_FILE`, `LOAD_BUFFER`, `LOAD_CACHED`, `DELETE_CACHE`, `FETCH_FOLDER`, `FETCH_BODY`, `SEARCH`, `EXPORT_EMAILS`, `EXPORT_FOLDER`
- **Responses** (Worker -> Main): `READY`, `FOLDER_EMAILS` (mit `totalCount` + `page`), `FOLDER_DONE`, `EMAIL_BODY`, `SEARCH_RESULTS`, `PROGRESS`, `ERROR`, `EXPORT_READY`, `CACHE_DELETED`

### React Hook (`usePSTWorker.ts`)
- Kapselt Worker-Lifecycle + Message-Handling
- Exponiert: `loadFile()`, `fetchFolder()`, `fetchBody()`, `search()`, `closeFile()`, `exportEmails()`, `exportFolder()`
- State: `tree`, `folderEmails` Map, `bodyCache` Map, `searchResults`, Loading/Error
- `bodyCache` wird zusaetzlich als Ref gefuehrt um stale closures in `fetchBody` zu vermeiden
- `indexedFolderCount` wird aus `folderEmails.size` abgeleitet (kein eigener State)
- **Paginierung**: `folderTotalCounts` (Map path->Gesamtzahl), `folderLoadingPaths` (Set der aktuell ladenden Ordner). `FOLDER_EMAILS` mit `page===0` ersetzt Array + setzt `folderLoadingPaths` auf nur diesen Pfad (raeumt gecancelte Pfade automatisch auf). `page>0` appendet. `FOLDER_DONE` entfernt aus `folderLoadingPaths`.

### Virtualisierung (`VirtualEmailList.tsx`)
- `@tanstack/react-virtual` mit `useVirtualizer`
- ~15 DOM-Nodes + 5 Overscan, unabhaengig von Email-Anzahl
- Enthaelt auch `HighlightText`, `ImportanceBadge`, `formatDate`, `getSnippet`

## Build

```bash
cd pst-viewer
npm install
npm run build        # -> dist/index.html (einzelne Datei ~900KB)
```

Die Build-Ausgabe wird auch nach `pst-viewer.html` im Projekt-Root kopiert.

### Vite Worker Config
- `worker: { format: 'es' }` in vite.config.ts
- Worker-Import via `?worker&inline` -> Blob-URL, bleibt in der Single-File-Ausgabe

## TypeScript-Besonderheiten

- `verbatimModuleSyntax: true` -> `import type` fuer reine Typ-Imports
- `erasableSyntaxOnly: true` -> keine Enums, nur String-Unions/Discriminated Unions
- `noUnusedLocals` + `noUnusedParameters` -> strikt
- `Buffer.from(uint8.buffer as ArrayBuffer, ...)` wegen SharedArrayBuffer-Inkompatibilitaet

## Entwicklungsverlauf

### v1 — Monolithische App
- Alles in `App.tsx` (~874 Zeilen)
- PST-Parsing, IndexedDB, Suche, Rendering auf dem Main Thread
- Alle E-Mail-Bodies sofort geladen
- Buffer-Kopie bei `Buffer.from(arrayBuffer)`
- Alle Emails als DOM-Nodes gerendert
- Problem: Absturz bei PST-Dateien >300MB

### v2 — Worker + Lazy Loading + Virtualisierung (aktuell)
- PST-Parsing in Web Worker ausgelagert
- Zero-Copy Buffer + PSTUtil Monkey-Patch
- Lazy Folder Loading (Emails erst bei Klick)
- **Paginiertes Ordner-Laden**: Ordner mit 500+ Mails laden seitenweise (erste Seite 50, danach 200/Seite), erste Seite sofort sichtbar, Rest streamt im Hintergrund nach. Ordnerwechsel bricht laufendes Laden Race-frei ab (`folderLoadOpId`-Counter statt Pfad-Vergleich). Cache-Hits ebenfalls paginiert. Header zeigt "X / Y Nachrichten" waehrend Laden.
- Lazy Body Loading (Body erst bei Auswahl)
- IndexedDB komplett im Worker
- Suche ueber besuchte Ordner (Metafelder, kein Body-Text) — waechst inkrementell bei paginiertem Laden
- Virtualisierte E-Mail-Liste
- **EML-Export**: Suchergebnisse oder ganze Ordner als EML in ZIP exportieren (HTML/TXT/Attachments waehlbar, strikt RFC-konform, im Worker). Warnung bei grossen Exporten.
- **Ordner-Export**: `EXPORT_FOLDER` Command — iteriert Ordner direkt via Cursor (effizienter als Einzel-Lookups)
- **Hilfe-Dialog**: Ausfuehrliche Hilfe mit Tastenkuerzeln, Browser-Kompatibilitaet, Datenschutz
- **Info-Dialog**: Copyright, Tech Stack, Bibliotheken mit Autor/Version/Lizenz, Dank an AI-Tools
- Ziel: PST-Dateien bis 1GB+ fluessig verarbeiten

#### Speicher-Impact (500MB PST, geschaetzt)
| | v1 | v2 |
|---|---|---|
| Buffer-Kopie | +500MB | 0 |
| E-Mail-Bodies | alle im RAM | nur ausgewaehlte |
| DOM-Nodes | alle Emails | ~15 sichtbare |
| Main-Thread-Blocking | Ja | Nein (Worker) |
| Peak RAM | ~1500MB+ | ~600MB |
