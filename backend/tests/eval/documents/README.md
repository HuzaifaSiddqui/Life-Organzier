# Document extraction evaluation

`npm run eval:documents` (from `backend/`) runs every document in `manifest.json` through `analyzeDocument` (the
same code an upload runs, without database writes) and writes `docs/document-eval-results.md`.

- `fixtures/*.txt` — synthetic documents (no personal data), one per failure mode: multi-line records, tables with
  a header row, "Week 5" dates, ranges, 2-digit years, "Sept"/"Sep.", OCR slips, day-first numbers, ordinals,
  tickets, invoices, notices, Urdu / Roman Urdu, timetables.
- `images/` — some fixtures rendered as pages, clean and damaged (low contrast, blur, rotation, noise, low
  resolution) to measure OCR. Regenerate with `npx tsx scripts/make-document-images.ts`.
- `baseline.json` — the numbers before the accuracy work (`--save-baseline` rewrites it).

Flags: `--text-only` (skip OCR, fast), `--ai` (let the model run as well; default off), `--private`.

## Manifest

```json
{
  "now": "2026-10-05T05:00:00.000Z",
  "timezone": "Asia/Karachi",
  "documents": [
    {
      "file": "fixtures/table-pipe.txt",
      "docType": "SYLLABUS",
      "language": "eng",
      "categories": ["table"],
      "expectedDeadlines": [{ "titleContains": "Assignment 1", "date": "2026-10-14", "time": "5 PM" }],
      "expectedSchedules": [{ "titleContains": "Calculus", "days": [1, 3], "time": "9 AM", "room": "B-12" }]
    }
  ]
}
```

`now` is the day you uploaded the document (relative words and missing years are read against it). `date: null`
means the item should be found but left undated for review (e.g. a week number with no semester start).
`docType`: SYLLABUS, SCHEDULE, NOTES or OTHER; `language`: `eng` or `eng+urd`.

## Your own documents (private)

Put real files (PDF, DOCX, JPG/PNG, TXT) in `private/` with a `private/manifest.json` in the same format, then run
`npm run eval:documents -- --private`. The folder is gitignored and the report is written to
`private/results.md`, never to `docs/`.
