# PST Viewer

Browser-basierter Outlook PST-Datei-Viewer. Laeuft komplett lokal im Browser als einzelne HTML-Datei — kein Server, kein Upload, alle Daten bleiben auf dem Rechner.

## Features

- **PST-Dateien oeffnen** per Drag & Drop oder Dateiauswahl
- **Ordnerstruktur** navigieren (Posteingang, Gesendete Elemente, etc.)
- **E-Mails lesen** mit HTML- und Text-Ansicht
- **Anhaenge** anzeigen (Dateinamen und Anzahl)
- **Volltextsuche** ueber alle besuchten Ordner (Betreff, Absender, Empfaenger, Anhaenge)
- **EML-Export** — Suchergebnisse oder ganze Ordner als EML-Dateien in einer ZIP exportieren (HTML/Text/Anhaenge waehlbar, strikt RFC-konform)
- **OPFS-Cache** — grosse PST-Dateien werden im Browser-Cache gespeichert (kein erneutes Laden noetig)
- **Grosse Dateien** — optimiert fuer PST-Dateien bis 1GB+ (Web Worker, Lazy Loading, Virtualisierung)
- **Hilfe & Info** — ausfuehrliche Hilfe (F1) und Info-Dialog mit Lizenzen und Credits

## Demo

Die fertige Anwendung ist eine einzelne HTML-Datei (`pst-viewer.html`). Einfach im Browser oeffnen — fertig.

## Schnellstart

### Fertige Datei verwenden

1. `pst-viewer.html` herunterladen
2. Im Browser oeffnen (Chrome/Edge empfohlen)
3. PST-Datei per Drag & Drop oder ueber "Datei > PST-Datei oeffnen" laden

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
│  - Export-Dialog     │       │  - ZIP (fflate)      │
└─────────────────────┘       └──────────────────────┘
```

- **Web Worker**: Alle schwere Arbeit (PST-Parsing, EML-Erzeugung, ZIP-Komprimierung) laeuft im Worker-Thread — der Main-Thread bleibt responsiv
- **Lazy Loading**: E-Mail-Metadaten werden erst beim Ordner-Klick geladen, Body erst bei Auswahl
- **Paginierung**: Grosse Ordner (500+ Mails) werden seitenweise geladen, erste Seite sofort sichtbar
- **Virtualisierung**: Nur ~15 sichtbare DOM-Nodes, unabhaengig von der E-Mail-Anzahl
- **OPFS-Cache**: Grosse PST-Dateien werden einmalig in den Origin Private File System Cache kopiert

### Speicher-Optimierung

| Aspekt | Ohne Optimierung | Mit Optimierung |
|---|---|---|
| Buffer-Kopie | +500MB | 0 (Zero-Copy) |
| E-Mail-Bodies | alle im RAM | nur ausgewaehlte |
| DOM-Nodes | alle Emails | ~15 sichtbare |
| Main-Thread | blockiert | frei (Worker) |

## EML-Export

Suchergebnisse oder ganze Ordner koennen als EML-Dateien in einer ZIP-Datei exportiert werden:

1. **Suchergebnisse exportieren**: Suche ausfuehren → "Exportieren" im Such-Header
2. **Ordner exportieren**: Ordner auswaehlen → "Exportieren" im Ordner-Header
3. Optionen waehlen:
   - HTML-Inhalt einschliessen
   - Text-Inhalt einschliessen
   - Anhaenge einschliessen
4. ZIP wird automatisch heruntergeladen

Bei grossen Exporten (>=1000 Mails oder viele Anhaenge) erscheint eine Warnung mit Bestaetigung.

Die EML-Dateien sind strikt RFC-konform (RFC 5322, 2045-2049, 2047, 2231) und koennen in Thunderbird, Outlook, Apple Mail oder anderen E-Mail-Clients geoeffnet werden.

## Browser-Kompatibilitaet

| Browser | Kleine PST (<250MB) | Grosse PST (250MB+) |
|---|---|---|
| Chrome / Edge | Ja | Ja (OPFS-Cache) |
| Firefox | Ja | Ja (OPFS-Cache) |
| Safari | Ja | Eingeschraenkt |
| file:// Protokoll | Ja (Fallback) | Nein (kein OPFS) |

## Tastenkuerzel

| Kuerzel | Aktion |
|---|---|
| `Strg+O` | PST-Datei oeffnen |
| `Strg+F` | Suche fokussieren |
| `Escape` | Suche / Dialog schliessen |
| `F1` | Hilfe anzeigen |

## Projektstruktur

```
pst-viewer/
  src/
    types.ts              # Shared Types (EmailMeta, FolderNode, ExportOptions, Worker-Messages)
    pstWorker.ts          # Web Worker: PST-Parsing, IndexedDB, EML-Builder, ZIP-Export
    usePSTWorker.ts       # React Hook: Worker-Lifecycle + State
    VirtualEmailList.tsx  # Virtualisierte E-Mail-Liste
    App.tsx               # Haupt-UI (MenuBar, FolderTree, ExportDialog, HelpDialog, InfoDialog)
    main.tsx              # Entry Point
    fs-shim.ts            # Leerer fs-Shim fuer pst-extractor im Browser
    index.css             # Tailwind Import
  vite.config.ts          # Vite Config mit Worker-Inline + Node-Polyfills
  index.html              # HTML Template
pst-viewer.html           # Build-Ausgabe (einzelne HTML-Datei, ~900KB)
```

## Credits

Entwickelt mit Unterstuetzung von [Claude Code](https://claude.ai/code) (Anthropic) und [Codex CLI](https://openai.com/codex) (OpenAI).

Siehe Info-Dialog in der Anwendung fuer eine vollstaendige Liste aller verwendeten Bibliotheken mit Autoren und Lizenzen.

## Lizenz

MIT — &copy; 2026 MEUSE24
