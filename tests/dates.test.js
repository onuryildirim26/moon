/* README: "Dates are always YYYY-MM-DD local civil strings. Date is a scratch
 * tool, never stored." These tests pin the clock to just after midnight and
 * move the machine across time zones; the stored day must not move. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { load } = require("./load.js");

const ZONES = ["Europe/Istanbul", "America/Los_Angeles", "Pacific/Auckland", "UTC"];

/* Load Moon with the vm context's Date frozen at a local wall-clock time. */
function loadAt(y, m, d, hh, mm) {
  const ctx = load([]);
  vm.runInContext(`
    (function () {
      var Real = Date;
      var fixed = new Real(${y}, ${m - 1}, ${d}, ${hh}, ${mm}).getTime();
      function Frozen() {
        if (!(this instanceof Frozen)) return new Real(fixed).toString();
        var a = arguments;
        if (a.length === 0) return new Real(fixed);
        return new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(a))))();
      }
      Frozen.prototype = Real.prototype;
      Frozen.now = function () { return fixed; };
      Frozen.UTC = Real.UTC;
      Frozen.parse = Real.parse;
      Date = Frozen;
    })();
  `, ctx);
  const fs = require("node:fs");
  const path = require("node:path");
  for (const rel of ["js/core.js", "js/money.js", "js/dates.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });
  }
  return ctx.Moon;
}

for (const tz of ZONES) {
  test(`today() at 00:30 on 1 March is 2026-03-01 in ${tz}`, () => {
    process.env.TZ = tz;
    const { Dates } = loadAt(2026, 3, 1, 0, 30);
    assert.equal(Dates.today(), "2026-03-01");
  });

  test(`"2026-03-01" stays 1 March in ${tz}`, () => {
    process.env.TZ = tz;
    const { Dates } = load().Moon;
    assert.equal(Dates.parseFlexible("2026-03-01"), "2026-03-01");
    assert.equal(Dates.parseFlexible("01.03.2026"), "2026-03-01");
    assert.equal(Dates.periodKey("2026-03-01", 1), "2026-03");
  });
}

test("the trap is real: toISOString() moves an Istanbul 00:30 entry to the day before", () => {
  process.env.TZ = "Europe/Istanbul";
  assert.equal(new Date(2026, 2, 1, 0, 30).toISOString().slice(0, 10), "2026-02-28");
});

test("the other trap: new Date('2026-03-01') is UTC midnight, which is still February in Los Angeles", () => {
  process.env.TZ = "America/Los_Angeles";
  assert.equal(new Date("2026-03-01").getDate(), 28);
});

test("day arithmetic survives a daylight-saving jump", () => {
  process.env.TZ = "America/Los_Angeles";           /* clocks spring forward 8 Mar 2026 */
  const { Dates } = load().Moon;
  assert.equal(Dates.daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.deepEqual(Array.from(Dates.eachDay("2026-03-07", "2026-03-09")), ["2026-03-07", "2026-03-08", "2026-03-09"]);
});

test("civil strings sort chronologically as plain strings", () => {
  const days = ["2026-10-01", "2025-12-31", "2026-09-30", "2026-01-01"];
  assert.deepEqual(days.slice().sort(), ["2025-12-31", "2026-01-01", "2026-09-30", "2026-10-01"]);
});

test("periods: leap February and a mid-month start day", () => {
  const { Dates } = load().Moon;
  assert.deepEqual({ ...Dates.periodRange("2028-02", 1) }, { start: "2028-02-01", end: "2028-02-29", days: 29 });
  assert.deepEqual({ ...Dates.periodRange("2026-09", 15) }, { start: "2026-09-15", end: "2026-10-14", days: 30 });
  assert.equal(Dates.periodKey("2026-10-14", 15), "2026-09");
  assert.equal(Dates.periodKey("2026-10-15", 15), "2026-10");
});

test("impossible calendar days are refused, not rolled over", () => {
  const { Dates } = load().Moon;
  assert.equal(Dates.parseFlexible("31.02.2026"), null);
  assert.equal(Dates.parseFlexible("29.02.2026"), null);
  assert.equal(Dates.parseFlexible("29.02.2024"), "2024-02-29");
});
