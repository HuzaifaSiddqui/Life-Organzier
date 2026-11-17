import { localParts } from "./time.js";
import { zip } from "./zip.js";

/**
 * Tables → an Excel workbook (.xlsx), no dependency: one worksheet per table, a bold frozen header row, column widths
 * from the content, numbers as numbers and dates as real Excel dates in the user's time zone. Text is written inline
 * (no shared-strings part), which every spreadsheet app reads.
 */

export type Cell = string | number | boolean | Date | null | undefined;
export type Table = { name: string; headers: string[]; rows: Cell[][] };

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel's serial date for the wall-clock time of `d` in `tz` (days since 30 Dec 1899). */
export function excelDate(d: Date, tz: string): number {
  const p = localParts(d, tz);
  return (Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, d.getUTCSeconds()) - Date.UTC(1899, 11, 30)) / 86400000;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ . */
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";

function cellXml(ref: string, v: Cell, tz: string, header: boolean): string {
  if (v === null || v === undefined || v === "") return "";
  if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(String(v))}</t></is></c>`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : `<c r="${ref}" s="2"><v>${excelDate(v, tz)}</v></c>`;
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

const width = (v: Cell) => (v instanceof Date ? 17 : v === null || v === undefined ? 0 : Math.min(60, String(v).length + 2));

function sheetXml(t: Table, tz: string): string {
  const all = [t.headers as Cell[], ...t.rows];
  const cols = t.headers
    .map((_, c) => {
      const w = Math.max(8, ...all.map((r) => width(r[c])));
      return `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`;
    })
    .join("");
  const rows = all
    .map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cellXml(`${columnName(c)}${i + 1}`, v, tz, i === 0)).join("")}</row>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `</styleSheet>`;

export function toXlsx(tables: Table[], tz = "UTC"): Buffer {
  const sheets = tables.map((t, i) => ({ id: i + 1, name: sheetName(t.name), xml: sheetXml(t, tz) }));
  return zip([
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${sheets.map((s) => `<sheet name="${esc(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s) => ({ name: `xl/worksheets/sheet${s.id}.xml`, data: s.xml })),
  ]);
}

/** The same tables as one CSV file: each table under its name, a blank line between them. */
export function toCsv(tables: Table[]): string {
  const cell = (value: Cell): string => {
    if (value === null || value === undefined) return "";
    const s = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return tables.map((t) => [t.name.toUpperCase(), t.headers.join(","), ...t.rows.map((r) => r.map(cell).join(","))].join("\n")).join("\n\n");
}
