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

Put real files (PDF, DOCX, JPG/PNG, TXT) in `private/`, then:

1. `npm run docs:manifest-template` writes a **blank** `private/manifest.json` listing every file there (nothing is
   read from the documents or the pipeline; `-- --force` replaces an existing one).
2. Fill it in yourself: `now` (the date the documents are read as), and per document `docType`, the items that
   **should** be created (`expectedDeadlines`: title, date, optional time and kind; `expectedSchedules` for
   timetables) and the dates that **should not** become items (`shouldNotCreate`: date, reason, optional title).
   The file's `help` block explains each field.
3. `npm run eval:documents -- --private` (add `--ai` for the model). The report, `private/results.md`, has recall and
   precision per document and overall, wrong items reaching auto-create, and should-not items that were extracted.

How items are matched: `title` is a word match (every word of 3+ letters must appear in the extracted title, any
order, case ignored; a 5+ letter word may be one letter off, for OCR slips); `date` is exact (YYYY-MM-DD); `time`, when
given, is compared as a clock time (4 PM = 16:00); classes need the same set of days and start time. `kind` is
reported, not scored. Blank template rows are ignored. The folder is git-ignored: files, manifest and results never
leave this machine and are never committed.
