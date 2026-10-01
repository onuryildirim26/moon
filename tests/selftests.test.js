/* Every DOM-free module ships a console-only _selftest(). This file runs
 * each one under Node so the checks run on every push, not only when
 * someone remembers to open the console. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

/* The self-tests report in three shapes; reduce them to {count, failures}. */
function normalise(r) {
  if (Array.isArray(r.failed)) return { count: r.passed + r.failed.length, failures: r.failed };
  if (Array.isArray(r.failures) && typeof r.total === "number") return { count: r.total, failures: r.failures };
  if (Array.isArray(r.failures) && typeof r.checks === "number") return { count: r.checks, failures: r.failures };
  if (Array.isArray(r.results)) {
    return {
      count: r.results.length,
      failures: r.results.filter((x) => !x.ok).map((x) => x.name + ": " + x.detail)
    };
  }
  throw new Error("unrecognised self-test report: " + JSON.stringify(r).slice(0, 200));
}

for (const name of ["Money", "Dates", "CSV", "Store", "Model", "Importer"]) {
  test(`Moon.${name}._selftest() passes`, () => {
    const Moon = load().Moon;
    const report = Moon[name]._selftest();
    assert.notEqual(report.skipped, true, `${name} self-test skipped itself`);
    const { count, failures } = normalise(report);
    assert.ok(count > 0, `${name} self-test ran no checks`);
    assert.deepEqual(Array.from(failures, String), [], `${name}: ${failures.length} of ${count} checks failed`);
  });
}
