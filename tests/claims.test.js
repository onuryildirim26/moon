/* The README makes a few load-bearing claims about how Moon handles money,
 * dates and bank files. A claim nobody checks is a claim that rots, so each one
 * gets a test here, written against the sentence in the README rather than
 * against the implementation.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, ROOT } = require("./load.js");

/* --------------------------------------------------------------- money --- */

test("money is an integer number of minor units, never a float", () => {
  const { Moon } = load();
  const { Money } = Moon;

  assert.equal(Money.parse("19.99", { decimal: "." }).abs, 1999);
  assert.equal(Money.parse("1.234,56", { decimal: "," }).abs, 123456, "Turkish grouping");
  assert.equal(Money.parse("1,234.56", { decimal: "." }).abs, 123456, "English grouping");
  assert.equal(Money.parse("1234").abs, 123400, "a bare integer is whole units");
  assert.equal(Money.parse("0,05", { decimal: "," }).abs, 5);

  const negative = Money.parse("-19,9", { decimal: "," });
  assert.equal(negative.abs, 1990);
  assert.equal(negative.negative, true, "the sign is reported, not folded into the amount");

  for (const bad of ["", "   ", "abc", "1.2.3"]) {
    assert.equal(Money.parse(bad).ok, false, `"${bad}" should not parse`);
  }
});

test("a hundred subscriptions sum exactly, which floats would not", () => {
  const { Moon } = load();
  const one = Moon.Money.parse("19.99", { decimal: "." }).abs;

  let total = 0;
  for (let i = 0; i < 100; i += 1) total = Moon.Money.add(total, one);
  assert.equal(total, 199900, "integers add exactly");

  /* The reason the rule exists, stated as a test so it cannot be argued with:
     the drift is in the conversion, which is exactly where a naive
     implementation would put it. */
  assert.notEqual(19.99 * 100, 1999,
    "19.99 * 100 was supposed to miss 1999; if it no longer does, the rule needs rereading");
  assert.equal(Moon.Money.parse("19.99", { decimal: "." }).abs, 1999,
    "walking the digits lands on it exactly");
});

/* --------------------------------------------------------------- dates --- */

test("dates are local civil strings, with no UTC shift", () => {
  const { Moon } = load({ today: "2026-03-01" });
  const { Dates } = Moon;

  assert.equal(Dates.today(), "2026-03-01");
  assert.equal(Dates.periodKey("2026-03-01", 1), "2026-03",
    "the first of the month belongs to that month, not the one before");

  /* The trap the rule is written against: new Date("2026-03-01") is read as UTC,
     so west of Greenwich it is still February. */
  assert.equal(new Date("2026-03-01").getUTCMonth(), 2);
  assert.equal(Dates.periodKey("2026-01-01", 1), "2026-01");
  assert.equal(Dates.periodKey("2026-12-31", 1), "2026-12");
});

test("ISO civil strings sort chronologically", () => {
  const { Moon } = load();
  const dates = ["2026-10-01", "2026-09-30", "2026-01-05", "2027-01-01"];
  const sorted = Moon.util.sortBy(dates.slice(), (d) => d);
  assert.deepEqual(sorted, ["2026-01-05", "2026-09-30", "2026-10-01", "2027-01-01"]);
});

test("month ends and leap years come out right", () => {
  const { Moon } = load();
  const { Dates } = Moon;

  assert.equal(Dates.periodRange("2026-02", 1).end, "2026-02-28");
  assert.equal(Dates.periodRange("2028-02", 1).end, "2028-02-29", "2028 is a leap year");
  assert.equal(Dates.periodRange("2026-04", 1).days, 30);
  assert.equal(Dates.periodRange("2026-01", 1).days, 31);

  assert.equal(Dates.parseFlexible("31.02.2026"), null, "February has no 31st");
  assert.equal(Dates.parseFlexible("29.02.2028", { order: "dmy" }), "2028-02-29");
});

test("a period that starts mid-month keeps its own name", () => {
  const { Moon } = load();
  /* monthStartDay 15: the 15th of September through the 14th of October is
     "2026-09", because a period is named for the month it opens in. */
  assert.equal(Moon.Dates.periodKey("2026-09-20", 15), "2026-09");
  assert.equal(Moon.Dates.periodKey("2026-10-14", 15), "2026-09");
  assert.equal(Moon.Dates.periodKey("2026-10-15", 15), "2026-10");
});

/* ----------------------------------------------------------------- csv --- */

function parse(Moon, text) {
  const sniff = Moon.CSV.sniff(text);
  const parsed = Moon.CSV.parse(text, { delimiter: sniff.delimiter, headerRow: sniff.headerRow });
  return { sniff, parsed };
}

test("the delimiter is found behind a bank's preamble", () => {
  const { Moon } = load();
  const cases = [
    [",", ["MEGA BANK", "Branch: Kadikoy", "Account: **** 4471", "",
      "Date,Description,Amount",
      "2026-09-01,Salary,3200.00", "2026-09-02,Rent,-1150.00"]],
    [";", ["BANKA EKSTRESI", "Musteri No: 55", "",
      "Tarih;Açıklama;Tutar",
      "01.09.2026;MAAŞ;38.500,00", "02.09.2026;KİRA;-14.000,00"]],
    ["\t", ["STATEMENT", "", "Date\tDescription\tAmount",
      "2026-09-01\tSalary\t3200.00", "2026-09-02\tRent\t-1150.00"]],
    ["|", ["EXPORT v2", "", "Date|Description|Amount",
      "2026-09-01|Salary|3200.00", "2026-09-02|Rent|-1150.00"]],
  ];

  for (const [want, lines] of cases) {
    const { sniff } = parse(Moon, lines.join("\n"));
    assert.equal(sniff.delimiter, want,
      `expected ${JSON.stringify(want)} behind a preamble, got ${JSON.stringify(sniff.delimiter)}`);
  }
});

test("a delimiter inside quotes is not a delimiter", () => {
  const { Moon } = load();
  const text = [
    "Tarih;Açıklama;Tutar",
    '06.09.2026;"KAHVE DÜKKANI, KADIKÖY";-165,00',
  ].join("\n");
  const { parsed } = parse(Moon, text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].length, 3, "the quoted comma must not split the row");
  assert.equal(parsed.rows[0][1], "KAHVE DÜKKANI, KADIKÖY");
});

test("a byte order mark does not end up in the first header", () => {
  const { Moon } = load();
  const text = "﻿Tarih;Açıklama;Tutar\n01.09.2026;MAAŞ;38.500,00";
  const { parsed } = parse(Moon, text);
  assert.equal(parsed.headers[0], "Tarih",
    "a BOM left in place makes the first column match nothing");
});

test("a header repeated mid-file, and a total row at the end, are skipped", () => {
  const { Moon } = load();
  const text = [
    "Tarih;Açıklama;Tutar",
    "01.09.2026;MAAŞ;38.500,00",
    "Tarih;Açıklama;Tutar",
    "02.09.2026;KİRA;-14.000,00",
    "TOPLAM;;24.500,00",
  ].join("\n");
  const { parsed } = parse(Moon, text);
  const kinds = (parsed.issues || []).map((i) => i.kind);
  assert.ok(kinds.includes("repeatedHeader"), `expected a repeatedHeader issue, saw ${kinds}`);
  assert.ok(parsed.rows.length <= 3, "the page-break header should not become a record");
});

test("both sample statements in ornek/ import cleanly", () => {
  const { Moon } = load();

  const files = [
    ["ornek/ornek-ekstre-tr.csv", { delimiter: ";", decimal: ",", rows: 25 }],
    ["ornek/sample-statement-en.csv", { delimiter: ",", decimal: ".", rows: 24 }],
  ];

  for (const [relative, want] of files) {
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    const { sniff, parsed } = parse(Moon, text);

    assert.equal(sniff.delimiter, want.delimiter, `${relative}: delimiter`);
    assert.equal(parsed.rows.length, want.rows, `${relative}: row count`);

    const roles = Moon.Importer.guessRoles(parsed.headers, parsed.rows);
    assert.ok(roles.date !== null && roles.date !== undefined, `${relative}: no date column found`);
    assert.equal(roles.decimal, want.decimal, `${relative}: decimal separator`);

    const built = Moon.Importer.build(parsed, roles, { monthStartDay: 1, skipDuplicates: true });
    assert.equal(built.error ?? null, null, `${relative}: ${built.error}`);
    assert.equal(built.summary.rejected, 0, `${relative}: ${built.summary.rejected} row(s) rejected`);
    assert.equal(built.summary.ok, want.rows, `${relative}: not every row became an entry`);

    for (const draft of built.drafts) {
      assert.ok(Number.isInteger(draft.amount) && draft.amount > 0,
        `${relative}: amounts must be positive integers, saw ${draft.amount}`);
      assert.match(draft.date, /^\d{4}-\d{2}-\d{2}$/, `${relative}: ${draft.date} is not a civil date`);
      assert.ok(draft.direction === "in" || draft.direction === "out",
        `${relative}: direction must be in or out`);
    }
  }
});

test("a balance column is not mistaken for the amount", () => {
  const { Moon } = load();
  const text = fs.readFileSync(path.join(ROOT, "ornek/ornek-ekstre-tr.csv"), "utf8");
  const { parsed } = parse(Moon, text);
  const roles = Moon.Importer.guessRoles(parsed.headers, parsed.rows);

  assert.equal(parsed.headers[roles.amount], "Tutar");
  assert.notEqual(roles.amount, parsed.headers.indexOf("Bakiye"),
    "the running balance must not be read as the transaction amount");
});

/* ---------------------------------------------------------------- i18n --- */

test("the two catalogues carry the same keys and the same placeholders", () => {
  const { Moon } = load();
  const report = Moon.I18n._verify();

  /* Arrays made inside the vm carry that realm's prototype, so a strict deep
     compare against a host [] fails on the prototype alone. Copy them out. */
  const out = (value) => Array.from(value ?? []);

  assert.deepEqual(out(report.onlyInTr), [], "keys present only in Turkish");
  assert.deepEqual(out(report.onlyInEn), [], "keys present only in English");
  assert.deepEqual(out(report.paramMismatch), [],
    "the same key must take the same placeholders in both languages");
  assert.ok(report.total > 400, `expected a full catalogue, counted ${report.total}`);
});

test("nothing the code asks for is missing from the catalogue", () => {
  const { Moon } = load();

  /* Codes travel up from Store, Model, CSV and Importer as plain strings and are
     translated at the edge. A code with no sentence behind it shows the reader a
     key, so every one of them is resolved here. */
  const sources = ["store.js", "model.js", "csv.js", "importer.js", "ui.js", "app.js"];
  const pattern = /"((?:data|err|csv|money|form|a11y|common)\.[a-zA-Z0-9_.]+)"/g;

  const missing = [];
  for (const name of sources) {
    const code = fs.readFileSync(path.join(ROOT, "js", name), "utf8");
    for (const match of code.matchAll(pattern)) {
      const key = match[1];
      /* "common.theme." and friends are prefixes the code completes at runtime
         ("common.theme." + currentTheme()), not keys in their own right. */
      if (key.endsWith(".")) continue;
      if (!Moon.I18n.has(key)) missing.push(`${name}: ${key}`);
    }
  }

  assert.deepEqual(missing, [], "these keys are used in code but resolve to nothing");
});
