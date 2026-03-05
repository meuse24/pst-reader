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
- **Item-Typ-Erkennung**: `messageClass`-basierte Erkennung von Terminen (`IPM.Appointment`/`IPM.Schedule.Meeting`), Aufgaben (`IPM.Task`), Kontakten (`IPM.Contact`/`IPM.DistList`) und Journal-Eintraegen (`IPM.Activity`). Typ-spezifische Metadaten werden aus `PSTAppointment`/`PSTTask`/`PSTContact` extrahiert (Direktimport wie PSTUtil). `EmailMeta.itemType` ist optional (undefined = email, spart Structured-Clone-Bytes). Extra-Suchfelder (location, taskOwner, contactName/company/email) werden an `_searchText` angehaengt; `detectMatchField()` unterscheidet Attachment- von Extra-Parts via `attachmentNames.length` und liefert typ-spezifische Labels (Ort/Besitzer/Kontaktdaten).
- **Suche**: Volltextsuche im ausgewaehlten Ordner (Betreff, Absender, Empfaenger, Anhaenge, typ-spezifische Felder und Body). Fast-Path (RAM-only) wenn Ordner vollstaendig indiziert und kein Body-Search. Slow-Path liest per Cursor aus PST + schreibt Metadaten in `emailCache` zurueck (Cache-Writeback). SEARCH setzt `searchingActive = true` und `activeSearchFolderPath` (try/finally garantiert Bereinigung). Slow-Path inkrementiert `folderLoadOpId` um laufende FETCH_FOLDER-Cursor abzubrechen. Einzelne fehlerhafte Mails werden im Slow-Path per try/catch uebersprungen. Cache-Writeback nutzt `scanned >= total` (erlaubt fehlende Eintraege durch broken emails). Ergebnisse paginiert/chunked, Abbruch via `ABORT_SEARCH`. Treffer koennen waehrend laufender Suche geoeffnet werden. `SEARCH_YIELD_INTERVAL` = 200ms. `detectMatchField()` nutzt vorberechneten `_searchText`.
- **Hintergrund-Indizierung**: `INDEX_ALL` Command iteriert nach `READY` automatisch alle Ordner aus `folderCache`, laedt Metadaten in `emailCache`. Ordner werden priorisiert sortiert (Posteingang/Gesendete zuerst, dann absteigend nach `contentCount`). Yield alle ~200 Mails. Waehrend einer aktiven Suche pausiert INDEX_ALL vollstaendig (`searchingActive`-Flag, 50ms-Polling) statt nur 200ms. `activeSearchFolderPath` verhindert Cursor-Konflikte: wenn SEARCH denselben Ordner per Cursor durchlaeuft, wartet INDEX_ALL bis SEARCH fertig ist und prueft dann `completedFolders`. Fehlerhafte Ordner werden uebersprungen (try/catch pro Ordner). Memory-Cap: `emailCache` wird auf `EMAIL_CACHE_MAX_EMAILS = 500_000` begrenzt; `evictEmailCache()` entfernt bei Ueberschreitung die neuesten (unwichtigsten) Eintraege (Map-Insertion-Order rueckwaerts). `totalCachedEmails`-Zaehler wird an allen `emailCache.set()`/`completedFolders.add()`-Stellen gepflegt. `INDEX_PROGRESS` mit optionalem `paused: true` wenn auf Suche gewartet wird. Fortschritt in der Titelleiste ("Indizierung: X / Y Ordner").
- **EML-Export**: Suchergebnisse oder ganze Ordner als EML-Dateien in ZIP exportieren. RFC-konformer EML-Builder:
  - RFC 2047 Encoded-Word Splitting (max 75 Zeichen pro Wort, UTF-8-Zeichengrenzen)
  - RFC 5322 Header Folding (SHOULD 78, MUST 998 Zeichen pro Zeile)
  - RFC 2231 Filename-Encoding mit Dual-Filename (`filename=` ASCII-Fallback + `filename*=` UTF-8)
  - RFC 2822 Datums-Format, Header-Injection-Schutz (CR/LF-Sanitizing)
  - ZIP via `fflate` (zipSync). Fortschritt alle 10 Mails, Abbruch via `loadOpId`.
  - Warnung bei grossen Exporten (>=1000 Mails oder >=500 Mails mit Anhaengen)
- **E-Mail teilen**: `BUILD_EML` Command baut einzelne EML-Datei. Web Share API (`navigator.share({ files })`) wenn verfuegbar, sonst Fallback auf .eml-Download.
- **Fortschrittsanzeige**: Zwei Phasen — Copy-Phase (determinierter Balken mit Prozent, Updates alle ~2s) und Parse-Phase (indeterminierter Balken, gelesene Bytes alle ~2s via instrumentiertem `readSync`). Parse-Fortschritt wird direkt aus synchronem Code via `postMessage` gemeldet (non-blocking im Worker).
- **Ladevorgang abbrechen**: `ABORT_LOAD` Command inkrementiert `loadOpId`, laufende Lade-Operationen brechen beim naechsten Check ab. `yieldToMessageLoop()` (setTimeout 0) im Copy-Loop alle ~2s gibt Macrotask-Queue frei, damit `ABORT_LOAD` verarbeitet werden kann. Parse-Phase (synchron) ist nicht abbrechbar.
- **UI-Sperre waehrend Laden**: Datei-oeffnen-Button, Menue-Eintrag, Strg+O und Drag & Drop sind waehrend `loading` deaktiviert.

### Worker-Kommunikation (`types.ts`)
Typisierte Messages:
- **Commands** (Main -> Worker): `LOAD_FILE`, `LOAD_BUFFER`, `LOAD_CACHED`, `DELETE_CACHE`, `FETCH_FOLDER`, `FETCH_BODY`, `SEARCH`, `ABORT_SEARCH`, `EXPORT_EMAILS`, `EXPORT_FOLDER`, `FETCH_ATTACHMENT`, `BUILD_EML`, `ABORT_LOAD`, `INDEX_ALL`
- **Responses** (Worker -> Main): `READY`, `FOLDER_EMAILS` (mit `totalCount` + `page`), `FOLDER_DONE`, `EMAIL_BODY`, `SEARCH_RESULTS` (chunked + `requestId` + `append`), `SEARCH_PROGRESS`, `PROGRESS` (mit `phase: 'copy' | 'parse'`), `ERROR`, `EXPORT_READY`, `ATTACHMENT_DATA`, `EML_READY`, `INDEX_PROGRESS`, `CACHE_DELETED`

### React Hook (`usePSTWorker.ts`)
- Kapselt Worker-Lifecycle + Message-Handling
- Exponiert: `loadFile()`, `fetchFolder()`, `fetchBody()`, `search(query, folderPath)`, `abortSearch()`, `closeFile()`, `exportEmails()`, `exportFolder()`, `fetchAttachment()`, `shareEmail()`, `abortLoad()`
- State: `tree`, `folderEmails` Map, `bodyCache` Map, `searchResults`, `searching`, `searchProgress`, `indexProgress`, `loadingPhase`, Loading/Error
- `bodyCache` wird zusaetzlich als Ref gefuehrt um stale closures in `fetchBody` zu vermeiden
- `indexedFolderCount` kommt als worker-reported Count (`searchableFolderCount`) aus `FOLDER_EMAILS` (kein eigener Zaehler je View)
- **Paginierung**: `folderTotalCounts` (Map path->Gesamtzahl), `folderLoadingPaths` (Set der aktuell ladenden Ordner). `FOLDER_EMAILS` mit `page===0` ersetzt Array + setzt `folderLoadingPaths` auf nur diesen Pfad (raeumt gecancelte Pfade automatisch auf). `page>0` appendet. `FOLDER_DONE` entfernt aus `folderLoadingPaths`.

### Virtualisierung (`VirtualEmailList.tsx`)
- `@tanstack/react-virtual` mit `useVirtualizer`
- ~15 DOM-Nodes + 5 Overscan, unabhaengig von Email-Anzahl
- Enthaelt auch `HighlightText`, `ImportanceBadge`, `formatDate`, `getSnippet`, `getItemSnippet` (typ-spezifische Kurzinfo), Item-Type-Badges

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
- **Item-Typ-Erkennung**: Termine, Aufgaben, Kontakte und Journal-Eintraege werden via `messageClass` erkannt. Farbige Badges in der Liste, typ-spezifische Snippets (Uhrzeit/Ort, Status/Fortschritt, Firma/Telefon) und angepasste Detail-Ansichten (Beginn/Ende/Teilnehmer, Status/Faellig/Besitzer, Name/Firma/E-Mail/Telefon/Adresse). Suche durchsucht auch typ-spezifische Felder mit korrekten Match-Labels.
- Volltextsuche im ausgewaehlten Ordner (inkl. Body und typ-spezifische Felder) mit Fortschrittsanzeige, chunked Ergebnislieferung und Abbrechen; Treffer koennen bereits waehrend der Suche geoeffnet werden. Slow-Path Metadaten-Cache-Writeback.
- **Hintergrund-Indizierung**: Alle Ordner werden nach dem Oeffnen automatisch indiziert (`INDEX_ALL`). Priorisiert sortiert (Posteingang/Gesendete zuerst). Pausiert vollstaendig waehrend aktiver Suche (`searchingActive`-Polling). Fortschritt in Titelleiste ("Indizierung: X / Y Ordner", "(pausiert)" in gelb). Fehlerhafte Ordner uebersprungen.
- **Memory-Cap fuer grosse Dateien**: `emailCache` begrenzt auf `EMAIL_CACHE_MAX_EMAILS = 500_000`. Bei Ueberschreitung entfernt `evictEmailCache()` die neuesten (unwichtigsten) Eintraege. `totalCachedEmails`-Zaehler an allen Cache-Set-Stellen gepflegt.
- **Adaptiver Chunk-Cache (file://)**: `CHUNK_SIZE` (4 MB bei <4 GB RAM, 8 MB sonst) und Cache-Budget (64–512 MB, ~6% von `navigator.deviceMemory`) passen sich automatisch an. Ermoeglicht auch >20 GB PST-Dateien per `file://` zu verarbeiten.
- Virtualisierte E-Mail-Liste (nur ~15 DOM-Nodes)
- **EML-Export**: Suchergebnisse oder ganze Ordner als EML in ZIP exportieren (HTML/TXT/Attachments waehlbar, strikt RFC-konform, im Worker). Warnung bei grossen Exporten.
- **Ordner-Export**: `EXPORT_FOLDER` Command — iteriert Ordner direkt via Cursor (effizienter als Einzel-Lookups)
- **E-Mail teilen**: Einzelne E-Mail per Web Share API oder .eml-Download teilen (Share-Button im Detail-Header)
- **Fortschrittsanzeige**: Copy-Phase mit determiniertem Balken + Prozent, Parse-Phase mit indeterminiertem Balken + gelesene Bytes. Throttled auf ~2s-Intervalle um Ladevorgang nicht auszubremsen.
- **Abbrechen-Button**: Ladevorgang waehrend Copy- und Parse-Phase abbrechbar. UI-Sperre verhindert gleichzeitiges Oeffnen weiterer Dateien.
- **Sidebar-Animation**: CSS `transition-[width] duration-200` statt konditionellem Render; innere div bleibt stabil (keine Remounts).
- **App-Icon**: SVG-Ordner-Icon als base64-Favicon im `index.html`. Gleiche SVG als `AppIcon`-Komponente im Info-Dialog.
- **Hilfe-Dialog**: Ausfuehrliche Hilfe mit Tastenkuerzeln, "Grosse Dateien (>1 GB)"-Abschnitt, Browser-Kompatibilitaet, Datenschutz
- **Info-Dialog**: Copyright, Tech Stack, Bibliotheken mit Autor/Version/Lizenz, Dank an AI-Tools
- Ziel: PST/OST-Dateien bis >20 GB fluessig verarbeiten

#### Speicher-Impact (500 MB PST, geschaetzt)
| | v1 | v2 |
|---|---|---|
| Buffer-Kopie | +500 MB | 0 (Zero-Copy) |
| E-Mail-Bodies | alle im RAM | nur ausgewaehlte |
| DOM-Nodes | alle Emails | ~15 sichtbare |
| Main-Thread-Blocking | Ja | Nein (Worker) |
| emailCache RAM | unbegrenzt | max ~500k Mails (adaptiv) |
| Chunk-Cache (file://) | 32 MB fix | 64–512 MB adaptiv |
| Peak RAM | ~1500 MB+ | ~600 MB |

