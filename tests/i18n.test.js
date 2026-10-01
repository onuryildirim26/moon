/* README: "No string lives in a view, so the catalogue is the one place a
 * third language has to touch." */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

test("Turkish and English catalogues have the same keys and placeholders", () => {
  const report = load().Moon.I18n._verify();
  assert.ok(report.total > 0);
  assert.deepEqual(Array.from(report.onlyInTr), []);
  assert.deepEqual(Array.from(report.onlyInEn), []);
  assert.deepEqual(Array.from(report.paramMismatch, (x) => x.key), []);
});

test("adding a language is one catalogue plus one register() call", () => {
  const Moon = load().Moon;
  const de = Object.assign({}, Moon.Lang.en);
  assert.equal(Moon.I18n.register("de", de), true);
  assert.ok(Array.from(Moon.I18n.languages()).includes("de"));
});
