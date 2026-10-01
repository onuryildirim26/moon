/* Reading a bank's own statement, end to end, with no question asked.
 *
 * The owner dropped a real credit-card statement on Moon and Moon stopped to
 * ask him which column held the date. The two fixtures this suite reads are
 * invented stand-ins for that shape — an invented bank, invented merchants,
 * invented amounts — built to reproduce the two things that went wrong: a
 * guessed glyph width that merges the date, the payee and the amount into one
 * cell, and a transaction header set over three lines under an interest-rate
 * table that looks every bit as much like a header.
 *
 * Nothing in here comes from the owner's own files. The expected values below
 * are the fixtures' own, and the fixtures were written for this purpose.
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

const CARD = "ornek/ornek-kredi-karti-tr.pdf";
const ACCOUNT = "ornek/ornek-hesap-ekstresi-tr.pdf";

/* The transaction rows of ornek/ornek-kredi-karti-tr.pdf, exactly as they are
   printed on the page: dd/mm/yyyy, a dot decimal, no thousands separator, and a
   fourth column holding the instalment balance. Two rows carry an instalment
   count in the description and one is a payment into the card, which is the only
   negative amount on the page. */
const CARD_ROWS = [
  ["14/02/2026", "AYDEDE MARKET SUBE 12", "412.90", "0.00"],
  ["15/02/2026", "GUNESLI KAHVE EVI MERKEZ", "86.50", "0.00"],
  ["16/02/2026", "BULUT AKARYAKIT ISTASYON", "1250.00", "0.00"],
  ["17/02/2026", "FENER BILGISAYAR 1/12", "624.75", "6872.25"],
  ["19/02/2026", "ZEYTIN ECZANESI ORNEKKOY", "234.60", "0.00"],
  ["20/02/2026", "KOPRU INTERNET ABONELIK", "549.00", "0.00"],
  ["21/02/2026", "MASAL KITABEVI ORNEKKOY", "318.40", "0.00"],
  ["23/02/2026", "YOLCU KART DOLUM NOKTASI", "150.00", "0.00"],
  ["24/02/2026", "KUMSAL SPOR SALONU AYLIK", "890.00", "0.00"],
  ["26/02/2026", "DENIZYILDIZI SINEMA SALONU", "240.00", "0.00"],
  ["28/02/2026", "CINAR ELEKTRIK FATURASI", "736.15", "0.00"],
  ["02/03/2026", "LALE CICEKCI DUKKANI", "275.00", "0.00"],
  ["04/03/2026", "AYDEDE MARKET SUBE 12", "1084.35", "0.00"],
  ["06/03/2026", "HESABA ODEME MOBIL KANAL", "-3500.00", "0.00"],
  ["09/03/2026", "PERI BACASI SEYAHAT 1/3", "1420.00", "2840.00"],
];

/* The header the page sets over three lines, as it reads once the three bands
   are joined back into one row. */
const CARD_HEADERS = ["ISLEM TARIHI", "ACIKLAMA", "TUTAR (TL)", "KALAN TAKSIT TUTARI"];

/* How many lines of the card page are not transactions: the bank's name, the
   title, the card line, the two summary lines, the rate table with its heading,
   the three header bands, two instalment notes, two totals and three lines of
   legal footer. */
const CARD_SKIPPED = 19;

/* The transaction rows of ornek/ornek-hesap-ekstresi-tr.pdf: dd.mm.yyyy, a
   comma decimal, a dot for the thousands, an amount and a running balance. */
const ACCOUNT_ROWS = [
  ["02.03.2026", "AYDEDE MARKET", "-624,30", "11.855,85"],
  ["03.03.2026", "CINAR ELEKTRIK", "-418,70", "11.437,15"],
  ["05.03.2026", "KIRA TRANSFERI", "-9.000,00", "2.437,15"],
  ["06.03.2026", "MAAS ODEMESI", "41.250,00", "43.687,15"],
  ["09.03.2026", "BULUT OTOGAZ", "-1.180,00", "42.507,15"],
  ["11.03.2026", "KOPRU INTERNET", "-549,00", "41.958,15"],
  ["13.03.2026", "GUNES KAHVE EVI", "-97,50", "41.860,65"],
  ["17.03.2026", "ZEYTIN ECZANESI", "-263,40", "41.597,25"],
  ["20.03.2026", "SERBEST CALISMA ODEMESI", "7.500,00", "49.097,25"],
  ["23.03.2026", "YOLCU KART DOLUM", "-200,00", "48.897,25"],
  ["26.03.2026", "KITAP DUKKANI", "-345,60", "48.551,65"],
  ["30.03.2026", "SPOR SALONU AYLIK", "-890,00", "47.661,65"],
];

/* The same amounts in minor units, signed, which is what the importer has to
   arrive at from the strings above. Two of them are income. */
const ACCOUNT_MINOR = [
  -62430, -41870, -900000, 4125000, -118000, -54900,
  -9750, -26340, 750000, -20000, -34560, -89000,
];

/* The account page states both of these, so the twelve amounts can be checked
   against the page's own arithmetic rather than against this file. */
const ACCOUNT_OPENING = 1248015;
const ACCOUNT_CLOSING = 4766165;

const ACCOUNT_SKIPPED = 10;

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

function fixture(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, name)));
  return { name: path.basename(name), size: bytes.length, type: "application/pdf", _bytes: bytes };
}

/* Array.from on both levels: every array the reader returns was built inside
   the vm and carries that realm's Array.prototype, which a strict deep compare
   rejects however identical the contents. */
function plain(rows) {
  return Array.from(rows, function (row) { return Array.from(row); });
}

/* A file whose bytes are written here rather than printed by a browser, so a
   page can be given exactly one property — a picture on it and no text. */
function pdfOf(parts) {
  let total = 0;
  parts.forEach(function (part) { total += part.length; });
  const bytes = new Uint8Array(total);
  let at = 0;
  parts.forEach(function (part) {
    if (typeof part === "string") {
      for (let i = 0; i < part.length; i += 1) { bytes[at] = part.charCodeAt(i) & 0xff; at += 1; }
      return;
    }
    for (let i = 0; i < part.length; i += 1) { bytes[at] = part[i]; at += 1; }
  });
  return { name: "scan.pdf", size: bytes.length, type: "application/pdf", _bytes: bytes };
}

/* The card page's own geometry, written out as runs so the two failures it was
   built to reproduce can be tested without decoding a PDF first. The widths are
   the measured ones: twelve-point text, a ten-character date 60 units wide at
   x=24, the description at x=159, the amount right-aligned on 460 and the
   instalment balance right-aligned on 700. The header occupies three y bands
   fourteen units apart; the body rows sit seventeen apart. */
function cardRuns() {
  let order = 0;
  function run(y, x, text, width) {
    order += 1;
    return {
      page: 0, x: x, y: y, text: text,
      size: 12, width: width, measured: true, order: order,
    };
  }

  const header = [
    run(210, 24, "ISLEM", 36.01),
    run(210, 159, "ACIKLAMA", 60.69),
    run(210, 420, "TUTAR", 40.0),
    run(210, 660.64, "KALAN", 39.35),
    run(224, 24, "TARIHI", 39.33),
    run(224, 438, "(TL)", 22.0),
    run(224, 657.98, "TAKSIT", 42.01),
    run(238, 656.66, "TUTARI", 43.33),
  ];

  const body = [
    [252, "14/02/2026", 60.06, "AYDEDE MARKET SUBE 12", 155.38, 423.3, "412.90", 36.7, 676.64, "0.00", 23.36],
    [269, "15/02/2026", 60.06, "GUNESLI KAHVE EVI MERKEZ", 173.36, 430.0, "86.50", 30.0, 676.64, "0.00", 23.36],
    [286, "16/02/2026", 60.06, "BULUT AKARYAKIT ISTASYON", 174.0, 417.0, "1250.00", 43.0, 676.64, "0.00", 23.36],
    [303, "17/02/2026", 60.06, "FENER BILGISAYAR 1/12", 142.0, 423.3, "624.75", 36.7, 656.66, "6872.25", 43.33],
  ];

  const runs = header.slice();
  body.forEach(function (row) {
    runs.push(run(row[0], 24, row[1], row[2]));
    runs.push(run(row[0], 159, row[3], row[4]));
    runs.push(run(row[0], row[5], row[6], row[7]));
    runs.push(run(row[0], row[8], row[9], row[10]));
  });
  return { runs: runs, header: header.length };
}

test("the measured glyph width splits a row the guessed one merged", () => {
  const Moon = load();
  const page = cardRuns();
  const row = page.runs.slice(page.header, page.header + 4);

  const measured = Moon.PDF._cellsFrom(row, 13.5);
  assert.deepEqual(Array.from(measured, function (cell) { return cell.text; }),
    ["14/02/2026", "AYDEDE MARKET SUBE 12", "412.90", "0.00"],
    "a row whose widths are known comes apart into its four columns");

  /* The same four runs with their widths withheld, against the one median
     advance the reader used to work from. A ten-character date at x=24 is then
     estimated to end at 24 + 10 * 13.5 = 159, which is exactly where the
     description starts: the gap computes as nothing, the threshold never fires,
     and three columns become one cell with no date in front of it. This is the
     failure the owner saw, and it is why the widths are read out of the file. */
  const blind = row.map(function (one) {
    return {
      page: one.page, x: one.x, y: one.y, text: one.text,
      size: one.size, order: one.order, measured: false, width: 0,
    };
  });
  const guessed = Array.from(Moon.PDF._cellsFrom(blind, 13.5), function (cell) { return cell.text; });
  assert.deepEqual(guessed, ["14/02/2026AYDEDE MARKET SUBE 12412.90", "0.00"],
    "the guess is what glued the date to the payee");
  assert.equal(guessed.length, 2, "four printed columns arrive as two");
  assert.equal(Moon.PDF._amountsIn(guessed[0]).length, 1,
    "with the amount buried in the description, no column of its own holds money");
});

test("a header set over three lines comes back as one row", () => {
  const Moon = load();
  const page = cardRuns();

  const lines = Moon.PDF._toLines(page.runs);
  assert.equal(lines.length, 7, "three header bands and four transaction rows");

  const rows = Moon.PDF._toRows(lines, 13.5);
  assert.equal(rows.length, 5, "the three bands join into the one row they are");

  const table = plain(rows.map(function (row) {
    return row.cells.map(function (cell) { return cell.text; });
  }));
  assert.deepEqual(table[0], CARD_HEADERS,
    "the wrapped cells read in the order they were printed, not in x order");

  /* A transaction never joins the line above it even when it sits as close as a
     wrapped header cell would: the date at its head starts a new row. */
  assert.deepEqual(table.slice(1), CARD_ROWS.slice(0, 4));
});

test("the header of a credit-card statement is the transaction header", async () => {
  const Moon = load();

  /* Shape alone cannot tell the two tables apart — three columns of rates above
     four columns of transactions both look like a heading with rows under it —
     so the transactions are found first and the header is the line above them.
     Reading this table by shape returns 1, the rate table. */
  const table = [
    ["ORNEK KREDI BANKASI A.S."],
    ["FAIZ ORANLARI", "AYLIK", "YILLIK"],
    ["Alisveris Faizi", "% 3.11", "% 37.32"],
    ["Nakit Avans Faizi", "% 4.11", "% 49.32"],
    ["Gecikme Faizi", "% 3.41", "% 40.92"],
    CARD_HEADERS,
    CARD_ROWS[0],
    CARD_ROWS[1],
  ];
  assert.equal(Moon.PDF._findHeader(table), 5, "the row above the first transaction");

  /* A page that opens straight into its transactions has no header at all, and
     saying so is what keeps the first transaction from being eaten as one. */
  assert.equal(Moon.PDF._findHeader([CARD_ROWS[0], CARD_ROWS[1]]), -1);

  const result = await Moon.PDF.read(fixture(CARD));
  assert.deepEqual(Array.from(result.headers), CARD_HEADERS);
  assert.equal(result.pass, "table", "the page's own grid produced these rows");
  assert.equal(result.passKey, "pdf.read.table");
  assert.equal(result.pages, 1, "one /Type /Page object, however many streams it took");
  assert.equal(result.lines, 34, "every text line on the page is counted");
  assert.deepEqual(Array.from(result.warnings), []);
});

test("every transaction row of a credit-card statement comes apart", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture(CARD));

  const rows = plain(result.rows);
  const transactions = rows.filter(function (row) { return Moon.PDF._datesIn(row[0]).length > 0; });

  assert.equal(transactions.length, CARD_ROWS.length, "fifteen transactions, no more and no fewer");
  assert.equal(result.usable, CARD_ROWS.length, "and the reader counts them the same way");
  assert.deepEqual(transactions, CARD_ROWS, "cell for cell, in the order they are printed");
  assert.deepEqual(transactions[0], CARD_ROWS[0]);
  assert.deepEqual(transactions[transactions.length - 1], CARD_ROWS[CARD_ROWS.length - 1]);
  assert.equal(result.skipped, CARD_SKIPPED, "and says how many lines were not transactions");
});

test("the rate table and the legal footer are not rows", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture(CARD));
  const rows = plain(result.rows);
  const page = rows.map(function (row) { return row.join(" "); }).join("\n");

  /* Everything on the page that is not a transaction and must not reach the
     ledger: the table above the transactions, the instalment note printed under
     two of them, and the three lines of small print at the foot. */
  for (const stray of ["FAIZ ORANLARI", "YILLIK", "% 3.11", "Alisveris Faizi",
    "Taksitli islemin", "Ticaret Sicil No", "Mersis", "Kredi Karti Hesap Ozeti",
    "Kart No", "Asgari Odeme"]) {
    assert.equal(page.indexOf(stray), -1, `"${stray}" belongs to no transaction row`);
  }

  /* The grid pass hands down every line that sits under the header and has more
     than one cell, exactly as Moon.CSV.parse hands down every line of a CSV, so
     the two totals printed below the transactions do come through. They carry no
     date, which is how the importer knows to leave them out; what matters here
     is that nothing WITHOUT a date also carries one. */
  const strays = rows.filter(function (row) { return Moon.PDF._datesIn(row[0]).length === 0; });
  assert.deepEqual(strays, [
    ["DONEM ICI ISLEM TOPLAMI", "8271.65", "", ""],
    ["DONEM BORCU", "4771.65", "", ""],
  ], "the totals, and nothing else, follow the transactions");
});

test("a current-account statement reads dd.mm.yyyy and comma decimals", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture(ACCOUNT));

  assert.deepEqual(Array.from(result.headers), ["Tarih", "Aciklama", "Tutar", "Bakiye"]);
  assert.deepEqual(plain(result.rows), ACCOUNT_ROWS,
    "four columns separated by real gaps, read back as four columns");
  assert.equal(result.usable, ACCOUNT_ROWS.length);
  assert.equal(result.skipped, ACCOUNT_SKIPPED,
    "the preamble, the header, the balances and the footer are not transactions");
  assert.equal(result.pass, "table");
  assert.equal(result.lines, 22);
  assert.equal(result.pages, 1);
});

test("the running balance is not read as the amount", async () => {
  const Moon = load();
  const result = await Moon.PDF.read(fixture(ACCOUNT));
  const roles = Moon.Importer.guessRoles(result.headers, result.rows);

  assert.equal(roles.amount, 2, "the column that moves both ways is the amount");
  assert.equal(roles.balance, 3, "the column that only follows the one before it is the balance");
  assert.equal(roles.decimal, ",");
  assert.equal(roles.dateOrder, "dmy");

  const built = Moon.Importer.build(
    { headers: result.headers, rows: result.rows, issues: [] },
    roles,
    { monthStartDay: 1, skipDuplicates: true }
  );
  assert.equal(built.error ?? null, null, String(built.error));

  /* Had the balance been taken for the amount, the first row would import as
     11.855,85 rather than as the 624,30 that was actually spent. */
  assert.equal(built.drafts[0].amount, 62430);

  const signed = built.drafts.map(function (draft) {
    return draft.direction === "in" ? draft.amount : -draft.amount;
  });
  assert.deepEqual(Array.from(signed), ACCOUNT_MINOR,
    "every amount in minor units, with the sign the page printed");

  /* Income keeps its sign: the two rows the page shows without a minus are the
     only two that come out as money coming in. */
  const incoming = [];
  built.drafts.forEach(function (draft, at) {
    if (draft.direction === "in") incoming.push(at);
  });
  assert.deepEqual(Array.from(incoming), [3, 8]);
  assert.equal(built.drafts[3].note, "MAAS ODEMESI");
  assert.equal(built.drafts[8].note, "SERBEST CALISMA ODEMESI");

  /* The page states its opening and closing balance, so the twelve amounts can
     be checked against the statement's own arithmetic instead of against the
     list above: a statement that adds up has been read correctly. */
  assert.equal(ACCOUNT_OPENING + built.summary.sumIn - built.summary.sumOut, ACCOUNT_CLOSING);
});

test("neither statement asks which column holds the date", async () => {
  const Moon = load();

  for (const name of [CARD, ACCOUNT]) {
    const result = await Moon.PDF.read(fixture(name));
    const roles = Moon.Importer.guessRoles(result.headers, result.rows);

    assert.equal(roles.date, 0, `${name}: the date column is found`);
    assert.notEqual(roles.amount, null, `${name}: the amount column is found`);
    assert.ok(roles.scores.date >= 0.6,
      `${name}: the date column is found on the evidence, not on a hunch (${roles.scores.date})`);
    assert.ok(roles.scores.amount >= 0.6,
      `${name}: so is the amount column (${roles.scores.amount})`);
    assert.notEqual(roles.amount, roles.balance, `${name}: the two are told apart`);

    /* What the preview says instead of asking: how many rows it read, and how
       many lines of the page it left out. */
    assert.equal(result.skipped, name === CARD ? CARD_SKIPPED : ACCOUNT_SKIPPED);
    assert.notEqual(Moon.I18n.t("csv.roles.guessed", { count: result.usable }), "csv.roles.guessed");
    assert.notEqual(Moon.I18n.t("csv.rows.skipped", { count: result.skipped }), "csv.rows.skipped");
  }
});

test("both statements build into drafts a ledger can take", async () => {
  const Moon = load();

  const expected = {};
  expected[CARD] = {
    count: CARD_ROWS.length,
    range: ["2026-02-14", "2026-03-09"],
    /* The amounts in minor units, unsigned, which is how a draft carries them:
       the direction is a field of its own. */
    amounts: [41290, 8650, 125000, 62475, 23460, 54900, 31840, 15000, 89000,
      24000, 73615, 27500, 108435, 350000, 142000],
  };
  expected[ACCOUNT] = {
    count: ACCOUNT_ROWS.length,
    range: ["2026-03-02", "2026-03-30"],
    amounts: ACCOUNT_MINOR.map(Math.abs),
  };

  for (const name of [CARD, ACCOUNT]) {
    const want = expected[name];
    const result = await Moon.PDF.read(fixture(name));
    const roles = Moon.Importer.guessRoles(result.headers, result.rows);
    const built = Moon.Importer.build(
      { headers: result.headers, rows: result.rows, issues: [] },
      roles,
      { monthStartDay: 1, skipDuplicates: true }
    );

    assert.equal(built.error ?? null, null, `${name}: ${built.error}`);
    assert.equal(built.drafts.length, want.count, `${name}: every transaction becomes a draft`);
    assert.equal(built.summary.ok, want.count);
    assert.deepEqual(Array.from(built.summary.dateRange), want.range, `${name}: the period read back`);
    assert.deepEqual(Array.from(built.drafts, function (draft) { return draft.amount; }), want.amounts,
      `${name}: every amount in minor units`);

    for (const draft of built.drafts) {
      assert.ok(Number.isInteger(draft.amount) && draft.amount > 0,
        `${name}: amounts stay positive integers, saw ${draft.amount}`);
      assert.match(draft.date, /^\d{4}-\d{2}-\d{2}$/, `${name}: ${draft.date} is not a civil date`);
      assert.ok(draft.direction === "in" || draft.direction === "out",
        `${name}: every draft knows which way the money went`);
    }

    /* Nothing that carried a date was turned away. A line the page printed
       without one — a total, a note — is not a transaction and was never a
       candidate. */
    for (const refused of built.rejected) {
      assert.equal(refused.reason, "badDate", `${name}: ${JSON.stringify(refused)}`);
    }
  }
});

test("a page that is a picture says so instead of importing nothing", async () => {
  const Moon = load();

  /* Either signal is enough on its own: a page holding less text than a heading
     would, or one carrying more bitmap per character than any logo accounts
     for. A page with no picture on it is never refused this way, however short. */
  assert.equal(Moon.PDF._scanVerdict(0, 0, 10, 1), null);
  assert.equal(Moon.PDF._scanVerdict(1, 400000, 50, 1), "pdf.err.scanned");
  assert.equal(Moon.PDF._scanVerdict(1, 400000, 1000, 1), "pdf.err.scanned");
  assert.equal(Moon.PDF._scanVerdict(1, 30000, 1000, 1), null,
    "a text statement with a logo on it still reads");

  /* One page, one image, one content stream that draws it and shows no text:
     this is what a statement saved out of a phone banking app arrives as. */
  const picture = new Uint8Array(4096);
  for (let i = 0; i < picture.length; i += 1) picture[i] = 32 + (i % 64);
  const file = pdfOf([
    "%PDF-1.4\n",
    "1 0 obj<</Type/Page/Contents 2 0 R/Resources<</XObject<</Im0 3 0 R>>>>>>endobj\n",
    "2 0 obj<</Length 30>>stream\nq 400 0 0 300 0 0 cm /Im0 Do Q\nendstream endobj\n",
    "3 0 obj<</Type/XObject/Subtype/Image/Width 64/Height 64/ColorSpace/DeviceGray"
      + "/BitsPerComponent 8/Length 4096>>stream\n",
    picture,
    "\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  ]);

  await assert.rejects(
    () => Moon.PDF.read(file),
    (error) => {
      assert.equal(error.key, "pdf.err.scanned",
        "not pdf.warn.fewRows, and not an empty table");
      return true;
    }
  );
});

test("the glyph widths are read out of the file, in both of /W's forms", () => {
  const Moon = load();

  /* /W comes in two shapes and one file uses both. "c [w1 w2 …]" gives one
     width per glyph from c on; "cFirst cLast w" gives one width to a whole run
     of glyphs. The array arrives without its outer brackets, which is what
     arrayValue hands over. */
  assert.deepEqual(Moon.PDF._parseWidths("3[600 500 400]10 12 250", {}),
    { 3: 600, 4: 500, 5: 400, 10: 250, 11: 250, 12: 250 });
  assert.deepEqual(Moon.PDF._parseWidths("1 4 500", {}), { 1: 500, 2: 500, 3: 500, 4: 500 });
  assert.deepEqual(Moon.PDF._parseWidths("7 [333]", {}), { 7: 333 });

  /* A run of glyphs wider than any font is a misread, not a font. */
  assert.deepEqual(Moon.PDF._parseWidths("1 999999 500", {}), {});
  assert.deepEqual(Moon.PDF._parseWidths("", {}), {});

  /* A Type0 font keeps its metrics one level down, in the CIDFont it descends
     to, and addresses its glyphs with two bytes per code. */
  const index = {
    5: "<</Type/Font/Subtype/Type0/Encoding/Identity-H/DescendantFonts[6 0 R]>>",
    6: "<</Type/Font/Subtype/CIDFontType2/DW 1000/W[3[600 500 400]10 12 250]>>",
    7: "<</Type/Font/Subtype/TrueType/FirstChar 65/Widths[722 667 611]/FontDescriptor 8 0 R>>",
    8: "<</Type/FontDescriptor/MissingWidth 500>>",
    9: "<</Type/Font/Subtype/TrueType/BaseFont/Helvetica>>",
  };

  /* Object.assign for the same reason the rows go through Array.from: the table
     was built inside the vm and carries that realm's Object.prototype, which a
     strict deep compare rejects however identical the contents. */
  const cid = Moon.PDF._fontMetrics(index, 5, {});
  assert.equal(cid.bytes, 2, "a CID font's codes are two bytes wide");
  assert.deepEqual(Object.assign({}, cid.widths),
    { 3: 600, 4: 500, 5: 400, 10: 250, 11: 250, 12: 250 });
  assert.equal(cid.missing, 1000, "/DW answers for a glyph /W does not list");

  const simple = Moon.PDF._fontMetrics(index, 7, {});
  assert.equal(simple.bytes, 1);
  assert.deepEqual(Object.assign({}, simple.widths), { 65: 722, 66: 667, 67: 611 },
    "/Widths is read from /FirstChar on");
  assert.equal(simple.missing, 500, "and the descriptor's /MissingWidth for the rest");

  /* A font that lists no widths at all leaves the estimate in place rather than
     reporting widths of zero, which would collapse every run set in it. */
  assert.equal(Moon.PDF._fontMetrics(index, 9, {}), null);
  assert.equal(Moon.PDF._fontMetrics(index, 404, {}), null);
});

test("every sentence the statement reader needs is in both catalogues", () => {
  const Moon = load();

  /* A key present in one language and missing in the other shows the reader an
     untranslated key, so both maps are checked directly. */
  const plainKeys = ["pdf.err.scanned", "pdf.read.table", "pdf.read.lines",
    "pdf.read.summary", "csv.roles.guessed", "csv.roles.fix"];
  const countedKeys = ["csv.rows.skipped.one", "csv.rows.skipped.other"];

  for (const key of plainKeys.concat(countedKeys)) {
    assert.ok(Moon.Lang.tr[key], `${key} is missing from the Turkish catalogue`);
    assert.ok(Moon.Lang.en[key], `${key} is missing from the English catalogue`);
  }

  /* csv.rows.skipped has no base key on purpose: t() appends the plural suffix
     itself, which is why the count has to be passed as a number. */
  assert.equal(Moon.I18n.has("csv.rows.skipped"), false);
  for (const lang of ["tr", "en"]) {
    Moon.I18n.setLang(lang);
    assert.match(Moon.I18n.t("csv.rows.skipped", { count: 19 }), /19/,
      `${lang}: the skipped-line count reaches the sentence`);
    assert.match(Moon.I18n.t("csv.roles.guessed", { count: 15 }), /15/,
      `${lang}: csv.roles.guessed falls through to its base key`);
    assert.notEqual(Moon.I18n.t("csv.roles.fix"), "csv.roles.fix");
    assert.notEqual(Moon.I18n.t("pdf.err.scanned"), "pdf.err.scanned");
  }
});

/* A credit card writes what it spent as a POSITIVE figure. An account writes
   the same money with a minus. Read a card under the account rule and a month
   of shopping lands in the ledger as a month of income — every limit, every
   allowance and the net worth then report the opposite of the truth, and
   nothing on screen looks broken enough for anyone to notice. Of everything
   the importer can get wrong, this is the one that does real damage quietly,
   so it is pinned here on both fixtures and in both directions. */
test("a card statement spends and an account statement does not get flipped", async () => {
  const Moon = load();

  const card = await Moon.PDF.read(fixture(CARD));
  assert.equal(card.documentKind, "card",
    "the page names itself a card in its masthead and summary box");

  const cardRoles = Moon.Importer.guessRoles(card.headers, card.rows,
    { documentKind: card.documentKind });
  assert.equal(cardRoles.signRule, "positiveIsExpense");

  const cardBuilt = Moon.Importer.build(
    { headers: card.headers, rows: card.rows, issues: [] }, cardRoles,
    { monthStartDay: 1, skipDuplicates: true });

  /* The page's own total of what the card spent this period. Every unsigned
     row is an expense and the one negative row is the payment that reduced the
     debt, so the two sums are the page's figures the right way round. */
  assert.equal(cardBuilt.summary.sumOut, 827165, "the purchases are expenses");
  assert.equal(cardBuilt.summary.sumIn, 350000, "the payment into the card is not");
  assert.equal(cardBuilt.drafts[0].direction, "out");

  const account = await Moon.PDF.read(fixture(ACCOUNT));
  assert.notEqual(account.documentKind, "card",
    "an account statement must never be taken for a card");

  const accountRoles = Moon.Importer.guessRoles(account.headers, account.rows,
    { documentKind: account.documentKind });
  assert.equal(accountRoles.signRule, "negativeIsExpense");

  const accountBuilt = Moon.Importer.build(
    { headers: account.headers, rows: account.rows, issues: [] }, accountRoles,
    { monthStartDay: 1, skipDuplicates: true });

  /* Salary and freelance income in, the rest out. The opposite of the card. */
  assert.equal(accountBuilt.summary.sumIn, 4875000);
  assert.equal(accountBuilt.summary.sumOut, 1356850);
  assert.equal(accountBuilt.drafts[0].direction, "out");
});

/* The instalment column on a card reads enough like a running balance that the
   role guesser claims it. That must not be allowed to veto the card reading, or
   the statement the owner actually sent would invert again. */
test("an instalment column claimed as a balance does not undo the card rule", () => {
  const Moon = load();
  const headers = ["Islem Tarihi", "Aciklama", "Tutar", "Kalan Taksit"];
  const rows = [
    ["14/02/2026", "AYDEDE MARKET", "412.90", "0.00"],
    ["17/02/2026", "FENER BILGISAYAR", "624.75", "6872.25"],
    ["06/03/2026", "HESABA ODEME", "-3500.00", "0.00"],
  ];

  const blind = Moon.Importer.guessRoles(headers, rows);
  const told = Moon.Importer.guessRoles(headers, rows, { documentKind: "card" });

  assert.equal(told.signRule, "positiveIsExpense",
    "the page saying 'card' settles it whatever the fourth column looks like");
  assert.equal(Moon.Importer.guessRoles(headers, rows, { documentKind: "account" }).signRule,
    "negativeIsExpense", "and a page saying 'account' settles it the other way");
  assert.ok(blind.signRule === "positiveIsExpense" || blind.signRule === "negativeIsExpense",
    "with no hint it still answers with one of the two readings");
});
