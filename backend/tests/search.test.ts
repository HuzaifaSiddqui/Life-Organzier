import assert from "node:assert/strict";
import test from "node:test";
import { MATCH, matchStrength, scoreFields, soundex } from "../src/modules/search/searchService.js";

test("match strength: exact word > substring > fuzzy > same sound > none", () => {
  assert.equal(matchStrength("kfc", "Eat burger from KFC Kalma Chowk"), MATCH.exact);
  assert.equal(matchStrength("kalma chowk", "KFC, Kalma Chowk, Gulberg III, Lahore"), MATCH.exact);
  assert.equal(matchStrength("burg", "Eat burger"), MATCH.substring);
  assert.equal(matchStrength("asignment", "Physics assignment 2"), MATCH.fuzzy);
  assert.equal(matchStrength("assignmnet", "Physics assignment 2"), MATCH.phonetic, "a swap is below the fuzzy bar but sounds the same");
  assert.equal(matchStrength("kentuky", "Kentucky fried chicken coupons"), MATCH.phonetic);
  assert.equal(matchStrength("kfc", "Kentucky fried chicken coupons"), 0, "KFC is not Kentucky by sound or spelling");
  assert.equal(matchStrength("walmart", "Eat burger from KFC"), 0);
  assert.equal(matchStrength("k f c", "KFC Gulberg"), MATCH.exact, "spelled letters");
  assert.equal(matchStrength("کے ایف سی", "کے ایف سی جانا"), MATCH.exact, "Urdu script");
  assert.equal(soundex("Kentucky"), soundex("Kentuky"));
  // Substrings: at a word start, or inside a word for 5+ letters only.
  assert.equal(matchStrength("art", "Start the essay"), 0, "'art' is not inside 'start'");
  assert.equal(matchStrength("art", "Birthday party"), 0, "'art' is not inside 'party'");
  assert.equal(matchStrength("art", "Art history notes"), MATCH.exact);
  assert.equal(matchStrength("phys", "Physics lab"), MATCH.substring, "word start");
  assert.equal(matchStrength("burger", "Grab a cheeseburger"), MATCH.substring, "5+ letters inside a word");
  assert.equal(matchStrength("461", "CSC461 assignment 3"), MATCH.substring, "a course number starts where the letters end");
});

test("every term must match; matchedIn lists where", () => {
  const fields = [
    { name: "title" as const, text: "Eat burger" },
    { name: "location" as const, text: "KFC" },
    { name: "location" as const, text: "KFC, Kalma Chowk, Gulberg III, Lahore" },
    { name: "notes" as const, text: "bring the coupon" },
  ];
  assert.deepEqual(scoreFields(["kfc"], fields), { score: MATCH.exact, matchedIn: ["location"] });
  assert.deepEqual(scoreFields(["kfc", "coupon"], fields)?.matchedIn, ["location", "notes"]);
  assert.equal(scoreFields(["kfc", "walmart"], fields), null);
});
