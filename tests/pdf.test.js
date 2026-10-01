/* Reading a bank statement out of a PDF.
 *
 * The fixture in ornek/ is a printed statement — real text in a real PDF, with
 * the subset font and the glyph-number encoding that printing produces, which
 * is exactly the shape a bank's own file arrives in. If this suite passes, the
 * thing a reader will actually drop on the page can be read.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { ROOT } = require("./load.js");

const FILES = [
  "js/core.js", "js/money.js", "js/dates.js", "js/lang.tr.js", "js/lang.en.js",
  "js/i18n.js", "js/csv.js", "js/pdf.js", "js/importer.js",
];

function load() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    JSON, Object, Array, String, Number, Math, Date, RegExp, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise, Error,
    Uint8Array, ArrayBuffer, TextDecoder, TextEncoder,
    DecompressionStream: globalThis.DecompressionStream,
    setTimeout, clearTimeout,
    navigator: { language: "tr-TR" },
  };
  sandbox.window = sandbox;

  /* The page reads bytes through FileReader; Node has none, so this is the
     smallest thing that behaves like one for readAsArrayBuffer. */
  sandbox.FileReader = class {
    readAsArrayBuffer(file) {
      const view = file._bytes;
      this.result = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      if (this.onload) this.onload();
    }
  };

  const ctx = vm.createContext(sandbox);
  for (const rel of FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
  }
  return sandbox.Moon;
}

function fixture(name = "ornek/ornek-ekstre-tr.pdf") {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, name)));
  return { name: path.basename(name), size: bytes.length, type: "application/pdf", _bytes: bytes };
}

test("the parts of a PDF string come apart correctly", () => {
  const Moon = load();
  const report = Moon.PDF._selftest();
  assert.deepEqual(Array.from(report.failures, String), [],
    `${report.failures.length} of ${report.checks} checks failed`);
  assert.ok(report.checks > 10, `expected a real suite, ran ${report.checks} checks`);
});

test("a printed statement reads back as a table", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture());

  /* Array.from: the reader builds its arrays inside the vm, so they carry that
     realm's Array.prototype and a strict deep compare against a host array
     fails on identical contents. */
  assert.deepEqual(Array.from(result.headers), ["Tarih", "Aciklama", "Tutar", "Bakiye"],
    "the header line is found under the bank's own preamble");
  assert.equal(result.rows.length, 14, "every statement line comes back");

  /* This page is printed at a fractional type size, so every glyph is
     positioned on its own and "Aciklama" arrives as eight runs. Whether a gap
     between two of them is a word space or nothing at all is decided against
     the width of the glyph before it, and the m of "Aciklam|a" is the widest
     letter in the word: while that width was a single median guessed for the
     whole page, the m was estimated too narrow, the gap after it read as a
     space, and the header came back as "Aciklam a". The widths now come out of
     the font, so the word is one word. */
  assert.equal(result.headers[1].indexOf(" "), -1,
    "a measured glyph width puts no space inside a word");

  /* What the reader now reports about the page itself, which is what the
     preview tells the reader in place of asking a question. */
  assert.equal(result.pass, "table", "the page's own grid produced these rows");
  assert.equal(result.passKey, "pdf.read.table");
  assert.equal(result.usable, 14, "every row carries both a date and an amount");
  assert.equal(result.lines, 17, "the raw text lines of the page, not the table's rows");
  assert.equal(result.pages, 1, "one /Type /Page object, however many streams it took");
  assert.equal(result.skipped, 3, "the bank's name, the preamble and the header");

  /* Rows in the order they were printed, not the order the file stored them:
     a printer is free to hand down a flipped axis and this one does. */
  assert.equal(result.rows[0][0], "01.09.2026");
  assert.equal(result.rows[13][0], "30.09.2026");

  /* Columns come from where the words sit. Nothing separates them in the file. */
  assert.equal(result.rows[0][1], "MAAS ODEMESI");
  assert.equal(result.rows[0][2], "38.500,00");
  assert.equal(result.rows[0][3], "41.230,55");
});

test("a statement read from a PDF imports like one read from a CSV", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture());

  const roles = Moon.Importer.guessRoles(result.headers, result.rows);
  assert.equal(roles.date, 0);
  assert.equal(roles.amount, 2);
  assert.equal(roles.balance, 3, "the running balance must not be read as the amount");
  assert.equal(roles.decimal, ",");
  assert.equal(roles.dateOrder, "dmy");

  const built = Moon.Importer.build(
    { headers: result.headers, rows: result.rows, issues: [] },
    roles,
    { monthStartDay: 1, skipDuplicates: true }
  );

  assert.equal(built.error ?? null, null, String(built.error));
  assert.equal(built.summary.rejected, 0, "no line should be unreadable");
  assert.equal(built.summary.ok, 14);
  assert.deepEqual(Array.from(built.summary.dateRange), ["2026-09-01", "2026-09-30"]);

  /* Salary in, rent out: the sign rule survives the trip through the page. */
  assert.equal(built.drafts[0].direction, "in");
  assert.equal(built.drafts[0].amount, 3850000);
  assert.equal(built.drafts[1].direction, "out");
  assert.equal(built.drafts[1].amount, 1400000);

  for (const draft of built.drafts) {
    assert.ok(Number.isInteger(draft.amount) && draft.amount > 0,
      `amounts stay positive integers, saw ${draft.amount}`);
    assert.match(draft.date, /^\d{4}-\d{2}-\d{2}$/, `${draft.date} is not a civil date`);
  }
});

test("a file that is not a PDF is refused by name, not by guesswork", async () => {
  const Moon = load();
  const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);   /* "hello" */
  const file = { name: "notes.pdf", size: bytes.length, type: "application/pdf", _bytes: bytes };

  await assert.rejects(
    () => Moon.PDF.read(file),
    (error) => {
      assert.equal(error.key, "pdf.err.notPdf");
      return true;
    }
  );
});

test("a PDF with no text layer says so instead of importing nothing", async () => {
  const Moon = load();
  /* A valid header and a page object, but not one glyph anywhere: this is what
     a scanned statement is — a picture of a page. */
  const text = "%PDF-1.4\n1 0 obj<</Type/Page>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  const file = { name: "scan.pdf", size: bytes.length, type: "application/pdf", _bytes: bytes };

  await assert.rejects(
    () => Moon.PDF.read(file),
    (error) => {
      assert.equal(error.key, "pdf.err.noText");
      return true;
    }
  );
});

test("an encrypted PDF asks for a copy without a password", async () => {
  const Moon = load();
  const text = "%PDF-1.4\ntrailer<</Encrypt 9 0 R/Root 1 0 R>>\n%%EOF";
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  const file = { name: "locked.pdf", size: bytes.length, type: "application/pdf", _bytes: bytes };

  await assert.rejects(
    () => Moon.PDF.read(file),
    (error) => {
      assert.equal(error.key, "pdf.err.encrypted");
      return true;
    }
  );
});

test("every message the reader can produce has a sentence behind it", () => {
  const Moon = load();
  for (const key of ["pdf.err.notPdf", "pdf.err.encrypted", "pdf.err.noText",
    "pdf.err.scanned", "pdf.warn.fewRows", "pdf.read.table", "pdf.read.lines",
    "pdf.read.summary", "csv.err.tooBig", "csv.err.readFailed"]) {
    assert.ok(Moon.I18n.has(key), `${key} has no sentence in the catalogue`);
  }
});
