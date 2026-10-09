import assert from "node:assert/strict";
import test from "node:test";
import { extractEntities } from "../src/modules/assistant/entities.js";
import { opts } from "./fixtures.js";

// NOW = Monday 2026-10-05 10:00 Karachi.
const date = (text: string) => extractEntities(text, opts).date?.ymd ?? null;
const time = (text: string) => extractEntities(text, opts).time;

test("roman urdu dates: aaj, kal, parson, agle hafte", () => {
  assert.equal(date("aaj"), "2026-10-05");
  assert.equal(date("kal"), "2026-10-06");
  assert.equal(date("kal tak"), "2026-10-06", "\"tak\" belongs to the date");
  assert.equal(date("parson"), "2026-10-07");
  assert.equal(date("agle hafte"), "2026-10-12");
  assert.equal(date("agla hafta"), "2026-10-12");
  assert.equal(extractEntities("agle hafte", opts).date?.fuzzy, true);
  assert.equal(date("is hafte"), "2026-10-09");
});

test("roman urdu weekdays: peer, somwar, mangal, budh, jumeraat, jumma, hafta, itwar", () => {
  const expected: Record<string, string> = {
    "peer ko": "2026-10-05",
    somwar: "2026-10-05",
    "mangal tak": "2026-10-06",
    mangalwar: "2026-10-06",
    budh: "2026-10-07",
    budhwar: "2026-10-07",
    jumeraat: "2026-10-08",
    jumerat: "2026-10-08",
    jumma: "2026-10-09",
    "jumme tak": "2026-10-09",
    "jumme ko": "2026-10-09",
    hafta: "2026-10-10",
    "hafte ko": "2026-10-10",
    itwar: "2026-10-11",
    ittwar: "2026-10-11",
    "agle peer": "2026-10-12",
    "agle somwar ko": "2026-10-12",
    "agle itwar": "2026-10-11",
    "is jumma": "2026-10-09",
  };
  for (const [text, ymd] of Object.entries(expected)) assert.equal(date(text), ymd, text);
});

test("roman urdu weekdays: look-alike words are not dates", () => {
  for (const t of ["har hafte", "ek hafte mein", "poore hafte", "peer review", "peer pressure", "my peer", "the peer"]) assert.equal(date(t), null, t);
  assert.equal(date("agle hafte"), "2026-10-12", "next week, not Saturday");
});

test("roman urdu parts of the day: subah, dopahar, shaam, raat", () => {
  assert.equal(time("subah"), "9 AM");
  assert.equal(time("dopahar"), "3 PM");
  assert.equal(time("shaam"), "6 PM");
  assert.equal(time("raat"), "9 PM");
  assert.equal(time("aaj raat"), "9 PM");
});

test("roman urdu clock: X baje with subah / shaam / raat deciding AM or PM", () => {
  const expected: Record<string, string> = {
    "subah 9 baje": "9 AM",
    "subah 5 baje": "5 AM",
    "shaam 5 baje": "5 PM",
    "shaam 7:30 baje": "7:30 PM",
    "raat 10 baje": "10 PM",
    "raat 12 baje": "12 AM",
    "raat 2 baje": "2 AM",
    "dopahar 1 baje": "1 PM",
    "dopahar 12 baje": "12 PM",
    "9 baje shaam": "9 PM",
    "nau baje": "9 AM",
    "saat baje shaam": "7 PM",
  };
  for (const [text, t] of Object.entries(expected)) assert.equal(time(text), t, text);
});

test("roman urdu clock: without a part of day the existing default hours apply", () => {
  assert.equal(time("9 baje"), "9 AM");
  assert.equal(time("11 baje"), "11 AM");
  assert.equal(time("12 baje"), "12 PM");
  assert.equal(time("3 baje"), "3 PM");
  assert.equal(time("5 baje"), "5 PM");
  assert.equal(time("15 baje"), "3 PM", "24-hour reading");
});

test("roman urdu clock: saarhe X (X:30), sawa X (X:15), pone X ((X-1):45), dhai, dedh", () => {
  const expected: Record<string, string> = {
    "saarhe teen baje": "3:30 PM",
    "sarhe 3 baje": "3:30 PM",
    "saade chaar baje": "4:30 PM",
    "subah saarhe nau baje": "9:30 AM",
    "saarhe barah baje": "12:30 PM",
    "sawa do baje": "2:15 PM",
    "sawa 9 baje subah": "9:15 AM",
    "pone char baje": "3:45 PM",
    "pone ek baje": "12:45 PM",
    "pone barah baje": "11:45 AM",
    "raat pone barah baje": "11:45 PM",
    "dhai baje": "2:30 PM",
    "dedh baje": "1:30 PM",
  };
  for (const [text, t] of Object.entries(expected)) assert.equal(time(text), t, text);
});

test("roman urdu clock: durations and plain words are not mistaken for clock times", () => {
  assert.equal(time("sawa do ghante lagenge"), null);
  assert.equal(time("do ghante"), null);
  assert.equal(time("dedh ghanta"), null);
  assert.equal(time("mujhe do chahiye"), null);
});

test("roman urdu: full sentences from the eval set", () => {
  const e = (t: string) => extractEntities(t, opts);
  let r = e("kal subah 9 baje doctor ke paas jana hai");
  assert.deepEqual([r.date?.ymd, r.time, r.residual], ["2026-10-06", "9 AM", "doctor ke paas jana hai"]);
  r = e("kal 2 ghante coding practice karni hai");
  assert.deepEqual([r.date?.ymd, r.time, r.durationMinutes], ["2026-10-06", null, 120]);
  r = e("essay ko kal pe shift kar do");
  assert.deepEqual([r.date?.ymd, r.residual], ["2026-10-06", "essay ko shift kar do"]);
  r = e("aaj shaam 6 baje meeting");
  assert.deepEqual([r.date?.ymd, r.time, r.residual], ["2026-10-05", "6 PM", "meeting"]);
  r = e("assignment jumme tak submit karni hai, 3 ghantay lagenge");
  assert.deepEqual([r.date?.ymd, r.durationMinutes], ["2026-10-09", 180]);
});
