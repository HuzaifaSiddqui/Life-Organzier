import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { exportFormat } from "../src/modules/analytics/analyticsService.js";
import { columnName, excelDate, toCsv, toXlsx, type Table } from "../src/lib/xlsx.js";

/** CSV and Excel exports (FR-AP-001 §3, FR-AN-002 §5): the workbook is a valid zip with one sheet per table. */

const tables: Table[] = [
  {
    name: "Tasks",
    headers: ["title", "progress", "due"],
    rows: [
      ['Essay, "draft" <2>', 40, new Date("2026-11-17T09:30:00.000Z")],
      ["رپورٹ", null, null],
    ],
  },
  { name: "Mood logs", headers: ["mood", "score"], rows: [["GOOD", 7]] },
];

test("xlsx: a zip with the workbook parts, one sheet per table, text escaped, numbers and dates typed", async () => {
  const book = await JSZip.loadAsync(toXlsx(tables, "Asia/Karachi"));
  const names = Object.keys(book.files).sort();
  assert.deepEqual(names, ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  const workbook = await book.file("xl/workbook.xml")!.async("string");
  assert.match(workbook, /<sheet name="Tasks" sheetId="1" r:id="rId1"\/><sheet name="Mood logs" sheetId="2" r:id="rId2"\/>/);

  const sheet = await book.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t>title<\/t><\/is><\/c>/, "bold header");
  assert.match(sheet, /<t xml:space="preserve">Essay, &quot;draft&quot; &lt;2&gt;<\/t>/, "escaped text");
  assert.match(sheet, /<c r="B2"><v>40<\/v><\/c>/, "number");
  // 17 Nov 2026 14:30 in Karachi (UTC+5) as an Excel serial date with the date style.
  assert.match(sheet, new RegExp(`<c r="C2" s="2"><v>${excelDate(new Date("2026-11-17T09:30:00.000Z"), "Asia/Karachi")}</v></c>`));
  assert.match(sheet, /<t xml:space="preserve">رپورٹ<\/t>/, "Urdu text kept");
  assert.ok(!sheet.includes('r="B3"'), "empty cells are left out");
  assert.match(sheet, /state="frozen"/, "header row frozen");
});

test("xlsx helpers: column letters and Excel dates", () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(columnName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  assert.equal(excelDate(new Date("2026-11-17T00:00:00.000Z"), "UTC"), 46343);
  assert.equal(excelDate(new Date("2026-11-17T19:00:00.000Z"), "Asia/Karachi"), 46344);
});

test("csv: tables under their names, quoted where needed; formats default to csv", () => {
  assert.equal(
    toCsv(tables),
    'TASKS\ntitle,progress,due\n"Essay, ""draft"" <2>",40,2026-11-17T09:30:00.000Z\nرپورٹ,,\n\nMOOD LOGS\nmood,score\nGOOD,7',
  );
  assert.equal(exportFormat("xlsx"), "xlsx");
  assert.equal(exportFormat("pdf"), "csv");
  assert.equal(exportFormat(undefined), "csv");
});
