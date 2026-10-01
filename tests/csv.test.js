/* README: Turkish (; and 1.234,56) and English (, and 1,234.56) statements
 * both work, along with BOM headers, quoted delimiters, preamble junk and
 * repeated header rows. One test per claim, plus the two sample files. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, ROOT } = require("./load.js");

const { CSV, Money } = load().Moon;

function readSample(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, "ornek", name)));
  const decoded = CSV.decode(bytes);
  return { decoded, parsed: CSV.parse(decoded.text) };
}

function dataLines(name) {
  return fs.readFileSync(path.join(ROOT, "ornek", name), "utf8")
    .split(/\r?\n/).filter((l) => l.trim() !== "").length - 1;
}

test("Turkish sample: ; delimiter, every row read, balances reconcile to the kuruş", () => {
  const name = "ornek-ekstre-tr.csv";
  const { decoded, parsed } = readSample(name);
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(Array.from(parsed.headers), ["Tarih", "Açıklama", "Tutar", "Bakiye"]);
  assert.equal(parsed.rows.length, dataLines(name));
  assert.equal(parsed.issues.length, 0);

  /* Each balance is the previous balance plus this row's amount. Integer
     arithmetic has to land on the bank's number exactly, row after row. */
  let balance = Money.parse(parsed.rows[0][3]).minor;
  for (let i = 1; i < parsed.rows.length; i += 1) {
    const [date, , amount, printed] = parsed.rows[i];
    balance += Money.parse(amount).minor;
    assert.equal(balance, Money.parse(printed).minor, `row ${i + 1} (${date})`);
  }
});

test("English sample: , delimiter, split debit/credit columns, exact totals", () => {
  const name = "sample-statement-en.csv";
  const { parsed } = readSample(name);
  assert.equal(parsed.delimiter, ",");
  assert.deepEqual(Array.from(parsed.headers), ["Date", "Description", "Debit", "Credit"]);
  assert.equal(parsed.rows.length, dataLines(name));
  for (const row of parsed.rows) {
    const debit = row[2] ? Money.parse(row[2]) : null;
    const credit = row[3] ? Money.parse(row[3]) : null;
    assert.ok((debit && debit.ok) || (credit && credit.ok), `no amount in ${row.join(",")}`);
    for (const r of [debit, credit]) if (r) assert.ok(Number.isInteger(r.minor));
  }
});

test("a byte-order mark does not end up inside the first header", () => {
  const p = CSV.parse("﻿Tarih;Tutar\n01.09.2026;1,00\n");
  assert.equal(p.headers[0], "Tarih");
});

test("a delimiter inside quotes stays inside the field", () => {
  const p = CSV.parse('Date,Description,Amount\n2026-09-01,"Coffee, large",4.50\n');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0][1], "Coffee, large");
  assert.equal(p.rows[0][2], "4.50");
});

test("free text above the header is skipped", () => {
  const text = "Hesap Özeti\nMüşteri: Ali Veli\nDönem: Eylül 2026\n\n" +
    "Tarih;Açıklama;Tutar\n01.09.2026;A;-1,00\n02.09.2026;B;-2,00\n";
  const p = CSV.parse(text);
  assert.deepEqual(Array.from(p.headers), ["Tarih", "Açıklama", "Tutar"]);
  assert.equal(p.rows.length, 2);
});

test("Excel's sep=; line is honoured and not read as data", () => {
  const p = CSV.parse("sep=;\nTarih;Açıklama;Tutar\n01.09.2026;A;-1,00\n");
  assert.equal(p.delimiter, ";");
  assert.equal(p.rows.length, 1);
});

test("a header repeated mid-file (page breaks) is dropped and reported", () => {
  const p = CSV.parse("Tarih;Açıklama;Tutar\n01.09.2026;A;-1,00\nTarih;Açıklama;Tutar\n02.09.2026;B;-2,00\n");
  assert.equal(p.rows.length, 2);
  assert.equal(p.skipped.repeatedHeader, 1);
});

test("decimal mark is decided per column, by vote", () => {
  assert.equal(CSV.detectDecimal(["1.234,56", "-14.000,00", "12,50"]), ",");
  assert.equal(CSV.detectDecimal(["1,234.56", "1,150.00", "11.99"]), ".");
});
