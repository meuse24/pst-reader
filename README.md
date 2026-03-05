# PST Viewer

Browser-basierter Outlook PST/OST-Datei-Viewer. Laeuft vollstaendig lokal im Browser als einzelne HTML-Datei — kein Server, kein Upload, alle Daten bleiben auf dem Rechner.

## Features

- **PST- und OST-Dateien oeffnen** per Drag & Drop oder Dateiauswahl — auch Dateien >20 GB
- **Ordnerstruktur** navigieren (Posteingang, Gesendete Elemente, etc.)
- **E-Mails lesen** mit HTML- und Text-Ansicht, ungelesene Mails hervorgehoben
- **Anhaenge** anzeigen und herunterladen
- **Termine, Aufgaben & Kontakte** werden automatisch erkannt und typ-spezifisch dargestellt
- **Volltextsuche** mit Hintergrund-Indizierung — Header-Suche laeuft quasi-instant nach Indizierung
- **EML-Export** — Suchergebnisse oder ganze Ordner als ZIP mit EML-Dateien (RFC-konform)
- **E-Mail teilen** per Web Share API oder EML-Download
- **OPFS-Cache** — grosse Dateien werden im Browser-Cache gespeichert (kein erneutes Laden)
- **Hilfe & Info** — Tastenkuerzel, Browser-Kompatibilitaet, Lizenzen (F1)

## Demo

Die fertige Anwendung ist eine einzelne HTML-Datei (`pst-viewer.html`). Im Browser oeffnen — fertig.

> **Tipp fuer Dateien >1 GB:** Die App ueber einen lokalen HTTP-Server oeffnen (z.B. `npx serve .`) statt direkt per `file://`. Das aktiviert OPFS und reduziert den Speicherbedarf erheblich.

## Schnellstart

### Fertige Datei verwenden

1. `pst-viewer.html` herunterladen
2. Im Browser oeffnen — Chrome/Edge empfohlen
3. PST/OST-Datei per Drag & Drop oder ueber **Datei > PST-Datei oeffnen** laden

### Selbst bauen

```bash
cd pst-viewer
npm install
npm run build
```

Die Build-Ausgabe (`dist/index.html`) wird automatisch als `pst-viewer.html` ins Projekt-Root kopiert.

## Tech Stack

| Bereich | Technologie |
|---|---|
| UI | React 19 + TypeScript 5.9 (strict) |
| Styling | Tailwind CSS 4 |
| Build | Vite 7 + vite-plugin-singlefile |
| PST-Parsing | pst-extractor |
| Virtualisierung | @tanstack/react-virtual |
| ZIP-Export | fflate |

## Architektur

```
Browser (Main Thread)          Web Worker
┌─────────────────────┐       ┌──────────────────────┐
│  React App          │       │  PST-Parsing         │
│  - Ordnerbaum       │◄─────►│  - pst-extractor     │
│  - E-Mail-Liste     │ Msgs  │  - Lazy Loading      │
│  - Detail-Ansicht   │       │  - IndexedDB/OPFS    │
│  - Suche            │       │  - EML-Builder       │
│  - Export-Dialog    │       │  - ZIP (fflate)      │
└─────────────────────┘       └──────────────────────┘
```

- **Web Worker**: Alle schwere Arbeit laeuft im Hintergrund-Thread — Main-Thread bleibt immer responsiv
- **Lazy Loading**: Ordner-Metadaten erst beim Klick, Body erst bei Auswahl
- **Paginierung**: Ordner mit 500+ Mails laden seitenweise (erste 50 sofort, Rest streamt nach)
- **Virtualisierung**: Nur ~15 sichtbare DOM-Nodes, unabhaengig von der Mailanzahl
- **OPFS-Cache**: Grosse Dateien einmalig in den Origin Private File System Cache kopiert

### Suche & Indizierung

Nach dem Oeffnen indiziert der Viewer alle Ordner automatisch im Hintergrund — **Posteingang und Gesendete Elemente zuerst**, dann nach Mailanzahl absteigend.
Sobald ein Ordner indiziert ist, laeuft die Header-Suche darin ohne jede PST-I/O.
Waehrend einer aktiven Suche pausiert die Indizierung vollstaendig und gibt alle Ressourcen frei.

### Dateigroessen-Optimierung

| Aspekt | Ohne Optimierung | Mit Optimierung |
|---|---|---|
| Buffer-Kopie | +Dateigroesse RAM | 0 (Zero-Copy) |
| E-Mail-Bodies | alle im RAM | nur ausgewaehlte |
| DOM-Nodes | alle Mails | ~15 sichtbare |
| Main-Thread | blockiert | frei (Worker) |
| emailCache RAM | unbegrenzt | max ~500 MB (adaptiv) |
| Chunk-Cache (file://) | 32 MB fix | 64–512 MB adaptiv |

### Adaptiver Chunk-Cache (file://-Modus)

Im `file://`-Modus ohne OPFS liest der Viewer die PST-Datei ueber einen LRU-Chunk-Cache.
Die Groesse passt sich automatisch an den verfuegbaren Arbeitsspeicher an (`navigator.deviceMemory`):

| RAM | Chunk-Groesse | Cache-Budget |
|---|---|---|
| 1–2 GB | 4 MB | 64–128 MB |
| 4 GB | 8 MB | 256 MB |
| 8 GB+ | 8 MB | 512 MB |

## EML-Export

Suchergebnisse oder ganze Ordner koennen als EML-Dateien in einer ZIP-Datei exportiert werden:

1. **Suchergebnisse**: Suche ausfuehren → **Exportieren** im Such-Header
2. **Ordner**: Ordner auswaehlen → **Exportieren** im Ordner-Header
3. Optionen: HTML-Inhalt / Textinhalt / Anhaenge einschliessen
4. ZIP wird automatisch heruntergeladen

Die EML-Dateien sind strikt RFC-konform (RFC 5322, 2047, 2231) und koennen in Thunderbird, Outlook, Apple Mail u.a. geoeffnet werden.
Bei grossen Exporten (>=1000 Mails) erscheint eine Bestaetigung.

## Browser-Kompatibilitaet

| Browser | < 1 GB | > 1 GB |
|---|---|---|
| Chrome / Edge (http://) | OPFS | OPFS |
| Firefox (http://) | OPFS | OPFS |
| Safari | eingeschraenkt | begrenzt |
| file:// (alle Browser) | Chunk-Cache | Chunk-Cache (langsamer) |

## Tastenkuerzel

| Kuerzel | Aktion |
|---|---|
| `Strg+O` | PST-Datei oeffnen |
| `Strg+F` | Suche fokussieren |
| `Strg+B` | Ordnerleiste ein-/ausblenden |
| `Escape` | Suche / Dialog schliessen |
| `F1` | Hilfe anzeigen |

## Projektstruktur

```
pst-viewer/
  src/
    types.ts              # Shared Types (EmailMeta, FolderNode, Worker-Messages)
    pstWorker.ts          # Web Worker: PST-Parsing, Indizierung, EML-Builder, ZIP-Export
    usePSTWorker.ts       # React Hook: Worker-Lifecycle + State
    VirtualEmailList.tsx  # Virtualisierte E-Mail-Liste
    App.tsx               # Haupt-UI (MenuBar, FolderTree, ExportDialog, HelpDialog, InfoDialog)
    main.tsx              # Entry Point
    fs-shim.ts            # Leerer fs-Shim fuer pst-extractor im Browser
    index.css             # Tailwind Import
  vite.config.ts          # Vite Config mit Worker-Inline + Node-Polyfills
  index.html              # HTML Template
pst-viewer.html           # Build-Ausgabe (einzelne HTML-Datei, ~940 KB)
```

## Credits

Entwickelt mit Unterstuetzung von [Claude Code](https://claude.ai/code) (Anthropic) und [Codex CLI](https://openai.com/codex) (OpenAI).

Vollstaendige Bibliotheksliste mit Autoren und Lizenzen im Info-Dialog der Anwendung (Datei → Info).

## Lizenz

MIT — &copy; 2026 MEUSE24
