/* Every module carries its own checks, callable from the console as
 * Moon.Money._selftest(). They are the detailed coverage — several hundred
 * assertions about rounding, period edges, delimiter sniffing and the rest.
 * This file makes them run from `node --test`, so cloning the repo is enough to
 * find out whether it works, and CI can answer the same question on every push.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, readSelftest } = require("./load.js");

const MODULES = ["Money", "Dates", "Store", "Model", "CSV", "Importer", "Charts", "UI", "Sample"];

test("every file loads, in the order index.html declares", () => {
  const { Moon, loaded } = load();
  assert.equal(loaded.length, 19, "index.html lists 19 scripts");

  for (const branch of ["util", "bus", "dom", "Money", "Dates", "I18n", "Store",
    "Model", "CSV", "Importer", "Charts", "UI", "Sample", "Views", "App"]) {
    assert.ok(Moon[branch], `Moon.${branch} is missing after load`);
  }

  for (const view of ["panel", "ledger", "limits", "recurring", "goals", "debts", "data"]) {
    assert.ok(Moon.Views[view], `Moon.Views.${view} is missing`);
    assert.equal(typeof Moon.Views[view].render, "function",
      `Moon.Views.${view}.render must be a function`);
  }
});

for (const name of MODULES) {
  test(`${name}._selftest() reports no failures`, () => {
    const { Moon } = load({ today: "2026-09-15" });
    const module = Moon[name];
    assert.ok(module, `Moon.${name} is missing`);
    assert.equal(typeof module._selftest, "function", `Moon.${name}._selftest is missing`);

    const result = readSelftest(module._selftest());
    assert.equal(result.count, 0,
      `${name}: ${result.count} failing check(s): ` +
      JSON.stringify(result.failures.slice(0, 6)));
    assert.ok(result.passed > 0, `${name} ran no checks at all`);
  });
}

test("the suites together cover a meaningful number of checks", () => {
  const { Moon } = load({ today: "2026-09-15" });
  const total = MODULES.reduce((sum, name) => {
    const module = Moon[name];
    if (!module || typeof module._selftest !== "function") return sum;
    return sum + Number(readSelftest(module._selftest()).passed || 0);
  }, 0);

  /* Not a quality measure — a tripwire. If a refactor quietly drops a suite,
     the count falls off a cliff and this says so instead of staying green. */
  assert.ok(total > 500, `expected more than 500 checks in total, counted ${total}`);
});
