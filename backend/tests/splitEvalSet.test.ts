import assert from "node:assert/strict";
import test from "node:test";
import { side, split } from "../scripts/split-eval-set.js";

test("classmate split: fixed per message, duplicates on one side only, about the share asked for, unlabelled skipped", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ text: `remind me about item ${i}`, command: "create_task" }));
  const a = split([...rows, { text: "  REMIND me about item 7 ", command: "create_task" }, { text: "no label", command: "" }]);
  assert.equal(a.duplicates, 1);
  assert.equal(a.unlabelled, 1);
  assert.equal(a.selection.length + a.heldout.length, 400);
  assert.ok(a.heldout.length > 160 && a.heldout.length < 240, `about half held out (${a.heldout.length})`);
  assert.equal(side("Remind me about item 7"), side("remind me  about item 7"), "same text (case, spaces) → same side");
  assert.deepEqual(split(rows).heldout, split([...rows].reverse()).heldout.reverse(), "order doesn't matter");
});
