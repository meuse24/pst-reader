# PST Viewer

Browser-basierter Outlook PST/OST-Viewer als Single-File-Web-App (ohne Server).

## Highlights

- Verarbeitung lokal im Browser (Web Worker)
- Lazy Loading fuer Ordner und Nachrichteninhalte
- Virtualisierte Nachrichtenliste fuer sehr grosse Ordner
- Volltextsuche im aktuell ausgewaehlten Ordner
  - durchsucht Betreff, Absender, Empfaenger, Anhaenge und Nachrichtentext
  - Fortschrittsanzeige und Abbrechen waehrend der Suche
  - Ergebnisse werden schrittweise nachgeladen
- Export von Suchtreffern oder ganzen Ordnern als ZIP mit EML-Dateien

## Tech Stack

- React 19 + TypeScript 5.9
- Vite 7 + `vite-plugin-singlefile`
- Tailwind CSS 4
- `pst-extractor` (PST Parsing)
- `@tanstack/react-virtual` (Virtualisierung)
- `fflate` (ZIP Export)

## Entwicklung

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Hinweis: Das Projekt nutzt im Build-Script aktuell `cp` zum Kopieren nach `../pst-viewer.html`.
Unter Windows PowerShell kann stattdessen z. B. `Copy-Item dist/index.html ../pst-viewer.html` verwendet werden.
