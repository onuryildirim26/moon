/* §3.3 counts a holding in units rather than in money, and stores that count as
 * an integer with four implied decimal places — half a bitcoin is 5000. Every
 * figure on the investments screen comes out of that one scaling rule, so a
 * fifth decimal slipping in, or a multiplication landing on a float, would not
 * fail loudly anywhere: it would just put a little error inside the portfolio
 * total and leave it there.
 *
 * This suite measures the rule end to end — the text a reader types, the
 * integer it becomes, the value and gain read back off the stored record, and
 * the price history the chart is drawn from.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

/* load.js hands back the vm context itself, and that context is what each of
 * Moon's files is given as `window`, so a shim assigned onto it is the
 * localStorage store.js resolves when boot() asks for one. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

/* A booted session with the seed install's records cleared, and the day pinned
 * so the twelve-period window investmentSeries() clips to is the same window
 * whatever date this suite is run on. */
function session(today = "2026-09-21") {
  const sandbox = load();
  sandbox.localStorage = new MemoryStorage();
  const Moon = sandbox.Moon;
  Moon.Dates.today = () => today;
  Moon.Store.boot();
  Moon.Store.update((draft) => {
    draft.entries = [];
    draft.accounts = [];
    draft.investments = [];
    draft.debts = [];
    draft.limits = [];
  }, { immediate: true });
  return Moon;
}

const { Money } = load().Moon;

/* Records come out of the vm carrying that realm's prototypes, and a strict
 * deep compare against a host object fails on identical contents. Array.from
 * is enough for a list of strings; a list of records needs its members copied
 * too, and a JSON round trip is lossless here because every one of these rows
 * came out of a JSON document in the first place. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("half a unit at 31.200 is worth 15.600, and the scale is the one §3.3 names", () => {
  assert.equal(Money.QUANTITY_SCALE, 10000);
  assert.equal(Money.QUANTITY_DIGITS, 4);

  const Moon = session();
  const id = Moon.Model.addInvestment({
    name: "BTC", kind: "crypto",
    quantity: Money.parseQuantity("0,5").value,
    unitCost: 24500, unitPrice: 31200, priceDate: "2026-09-02"
  });

  const record = Moon.Model.investmentById(id);
  assert.equal(record.quantity, 5000, "the stored count is an integer ×10⁴");
  assert.ok(Number.isInteger(record.quantity));

  const reading = Moon.Model.investmentValue(record);
  assert.equal(reading.value, 15600);
  assert.equal(reading.cost, 12250);
  assert.equal(reading.gain, 3350);
  for (const figure of [reading.value, reading.cost, reading.gain]) {
    assert.ok(Number.isInteger(figure), `${figure} must be an integer of minor units`);
  }
});

test("value, cost and gain on a winner and on a loser, the ratio in whole percent", () => {
  const Moon = session();

  const winner = Moon.Model.investmentById(Moon.Model.addInvestment({
    name: "BTC", kind: "crypto", quantity: 5000, unitCost: 24500, unitPrice: 31200, priceDate: "2026-09-02"
  }));
  const loser = Moon.Model.investmentById(Moon.Model.addInvestment({
    name: "THYAO", kind: "stock", quantity: 10000, unitCost: 30000, unitPrice: 24000, priceDate: "2026-09-02"
  }));

  const up = Moon.Model.investmentValue(winner);
  /* 3.350 on a cost of 12.250 is 27,3%, and gainRatio is already the whole
     percent investments.gainPct asks for — multiplying by 100 in a view would
     print 2700%. */
  assert.equal(up.gainRatio, 27);

  const down = Moon.Model.investmentValue(loser);
  assert.equal(down.value, 24000);
  assert.equal(down.cost, 30000);
  assert.equal(down.gain, -6000);
  assert.equal(down.gainRatio, -20);

  /* A holding entered without a cost is not up by infinity, it is uncosted, and
     the view needs to be able to tell those apart. */
  const uncosted = Moon.Model.investmentById(Moon.Model.addInvestment({
    name: "Hediye", kind: "gold", quantity: 10000, unitCost: 0, unitPrice: 500000, priceDate: "2026-09-02"
  }));
  assert.equal(Moon.Model.investmentValue(uncosted).gainRatio, null);

  /* A missing record must read as zeros rather than throw: the row is drawn
     from whatever the store handed over. */
  for (const absent of [null, undefined, {}]) {
    const nothing = Moon.Model.investmentValue(absent);
    assert.equal(nothing.value, 0);
    assert.equal(nothing.cost, 0);
    assert.equal(nothing.gain, 0);
    assert.equal(nothing.gainRatio, null);
  }
});

test("a quantity is read by the same separator rules in Turkish and in English", () => {
  /* The field has no language of its own: a reader typing a comma and a reader
     typing a point mean the same half unit, and the CSV wizard can force the
     mark it voted for per column. */
  for (const text of ["0,5", "0.5"]) {
    assert.equal(Money.parseQuantity(text).value, 5000, text);
  }
  assert.equal(Money.parseQuantity("0,5", { decimal: "," }).value, 5000);
  assert.equal(Money.parseQuantity("0.5", { decimal: "." }).value, 5000);

  /* A grouped Turkish quantity: 1.250,75 grams of gold. */
  assert.equal(Money.parseQuantity("1.250,75").value, 12507500);
  assert.equal(Money.parseQuantity("1,250.75").value, 12507500);

  /* Four places is the ceiling the schema keeps, so the fourth is kept exactly
     and a fifth is refused rather than rounded away — only the reader who typed
     it knows what they meant by it. */
  assert.equal(Money.parseQuantity("0,1234").value, 1234);
  assert.equal(Money.parseQuantity("1,0001").value, 10001);
  for (const tooFine of ["0,12345", "0,1234567", "1.250,75001"]) {
    const refused = Money.parseQuantity(tooFine);
    assert.equal(refused.ok, false, tooFine);
    assert.equal(refused.error, "err.quantityPrecision");
    assert.equal(refused.value, null);
  }

  /* A negative count of units is not a short position, it is a slip of the
     keyboard, and it has its own sentence because "too precise" and "not a
     number" would both be the wrong thing to say. */
  const negative = Money.parseQuantity("-0,5");
  assert.equal(negative.ok, false);
  assert.equal(negative.error, "err.quantityNegative");
  /* A signed zero is only zero. */
  assert.equal(Money.parseQuantity("-0").value, 0);

  for (const junk of ["", "   ", null, undefined, "abc", "1.2.3", "--5"]) {
    const refused = Money.parseQuantity(junk);
    assert.equal(refused.ok, false, JSON.stringify(junk));
    assert.equal(refused.error, "err.quantityInvalid");
    assert.equal(refused.value, null);
  }

  /* Every value that comes back is an integer, never a float. */
  for (const text of ["0,0001", "0,5", "1", "1.250,75", "9.999,9999"]) {
    assert.ok(Number.isInteger(Money.parseQuantity(text).value), text);
  }
});

test("formatQuantity prints what parseQuantity reads back", () => {
  assert.equal(Money.formatQuantity(5000, { lang: "tr" }), "0,5");
  assert.equal(Money.formatQuantity(5000, { lang: "en" }), "0.5");
  /* Trailing zeros are dropped: one share prints as "1", not as "1,0000",
     which would read as a measurement nobody made. */
  assert.equal(Money.formatQuantity(10000, { lang: "tr" }), "1");
  assert.equal(Money.formatQuantity(12507500, { lang: "tr" }), "1.250,75");
  assert.equal(Money.formatQuantity(12507500, { lang: "en" }), "1,250.75");
  assert.equal(Money.formatQuantity(0, { lang: "tr" }), "0");
  assert.equal(Money.formatQuantity(1, { lang: "tr" }), "0,0001");

  for (const value of [0, 1, 5000, 10000, 12507500, 100000000]) {
    for (const lang of ["tr", "en"]) {
      const text = Money.formatQuantity(value, { lang });
      const back = Money.parseQuantity(text, { decimal: lang === "tr" ? "," : "." });
      assert.equal(back.value, value, `${lang} ${text}`);
    }
  }
});

test("a new price appends a row, a corrected price replaces that day's row", () => {
  const Moon = session();
  const id = Moon.Model.addInvestment({
    name: "BTC", kind: "crypto", quantity: 5000, unitCost: 24500, unitPrice: 31200, priceDate: "2026-09-02"
  });

  /* addInvestment writes the opening row itself, because store.js deliberately
     does not invent one and §5.2's chart appears at the second price. */
  assert.deepEqual(plain(Moon.Model.investmentById(id).history),
    [{ date: "2026-09-02", unitPrice: 31200 }]);

  Moon.Model.setInvestmentPrice(id, 32000, "2026-09-10");
  assert.equal(Moon.Model.investmentById(id).history.length, 2);

  /* A second price on the same day is a correction of that day's reading, not a
     second reading. */
  Moon.Model.setInvestmentPrice(id, 33000, "2026-09-10");
  assert.equal(Moon.Model.investmentById(id).history.length, 2);

  /* A price filled in for an earlier day belongs where that day is, and must
     not become today's price. */
  Moon.Model.setInvestmentPrice(id, 31000, "2026-09-05");
  const record = Moon.Model.investmentById(id);
  assert.deepEqual(plain(record.history), [
    { date: "2026-09-02", unitPrice: 31200 },
    { date: "2026-09-05", unitPrice: 31000 },
    { date: "2026-09-10", unitPrice: 33000 }
  ]);
  assert.equal(record.unitPrice, 33000);
  assert.equal(record.priceDate, "2026-09-10");

  assert.equal(Moon.Model.setInvestmentPrice("i_nope", 100, "2026-09-10"), null);
  assert.equal(Moon.Model.setInvestmentPrice(id, "pahalı", "2026-09-10"), null);
});

test("a history longer than the ceiling keeps the newest rows, oldest first", () => {
  const Moon = session();
  const ceiling = Moon.Store.HISTORY_MAX;
  assert.equal(ceiling, 400);

  /* Built with Moon's own day arithmetic rather than with Date maths, so the
     dates stay civil strings and no local/UTC boundary creeps in. */
  const days = Moon.Dates.eachDay("2025-08-01", "2026-09-30");
  const written = days.slice(0, ceiling + 5);

  const id = Moon.Model.addInvestment({
    name: "GOLD", kind: "gold", quantity: 10000, unitCost: 100, unitPrice: 100, priceDate: written[0]
  });
  for (let i = 1; i < written.length; i += 1) {
    Moon.Model.setInvestmentPrice(id, 100 + i, written[i]);
  }

  const history = Moon.Model.investmentById(id).history;
  assert.equal(history.length, ceiling);
  /* The newest rows are the ones kept: the current value and the right-hand end
     of the chart are read from those. */
  assert.equal(history[0].date, written[5]);
  assert.equal(history[ceiling - 1].date, written[written.length - 1]);
  for (let i = 1; i < history.length; i += 1) {
    assert.ok(history[i - 1].date < history[i].date,
      `history must stay oldest first around ${history[i].date}`);
  }
});

test("investmentSeries is ordered oldest first and says nothing at all when there is nothing", () => {
  const Moon = session();
  /* No holdings: an empty list, not a point at zero. */
  assert.deepEqual(plain(Moon.Model.investmentSeries(12)), []);

  const id = Moon.Model.addInvestment({
    name: "GOLD", kind: "gold", quantity: 20000, unitCost: 300000, unitPrice: 320000, priceDate: "2026-09-03"
  });
  /* One price is one point, and §5.2 draws no chart until there are two. */
  const one = Moon.Model.investmentSeries(12);
  assert.equal(one.length, 1);
  assert.deepEqual(plain(one), [{ date: "2026-09-03", value: 640000 }]);

  /* Prices typed out of order still come back in date order. */
  Moon.Model.setInvestmentPrice(id, 340000, "2026-09-20");
  Moon.Model.setInvestmentPrice(id, 310000, "2026-09-10");
  const series = Moon.Model.investmentSeries(12);
  assert.deepEqual(Array.from(series.map((point) => point.date)),
    ["2026-09-03", "2026-09-10", "2026-09-20"]);
  assert.deepEqual(Array.from(series.map((point) => point.value)),
    [640000, 620000, 680000]);

  /* A second holding priced on its own days adds its own points, and every
     point values every holding at the newest price on or before that day. */
  Moon.Model.addInvestment({
    name: "BTC", kind: "crypto", quantity: 5000, unitCost: 24500, unitPrice: 31200, priceDate: "2026-09-12"
  });
  const both = Moon.Model.investmentSeries(12);
  assert.deepEqual(Array.from(both.map((point) => point.date)),
    ["2026-09-03", "2026-09-10", "2026-09-12", "2026-09-20"]);
  /* Before its first price the second holding counts as nothing rather than as
     its cost, because the chart records what the reader measured. */
  assert.equal(both[0].value, 640000);
  assert.equal(both[2].value, 620000 + 15600);
  assert.equal(both[3].value, 680000 + 15600);

  /* A holding whose history a hand-edited file left empty contributes no point
     and still carries a value. */
  const bare = session();
  bare.Store.update((draft) => {
    draft.investments = [{
      id: "i_bare", name: "Bare", kind: "other", quantity: 10000, unitCost: 500, unitPrice: 700,
      priceDate: "2026-09-01", currency: "TRY", note: "", color: "#8AA6FF", icon: "📦",
      archived: false, createdAt: "2026-09-01", history: []
    }];
  }, { immediate: true });
  assert.deepEqual(plain(bare.Model.investmentSeries(12)), []);
  assert.equal(bare.Model.investmentTotals().value, 700);
});

test("investmentTotals groups by kind and hands the bar its segments already ordered", () => {
  const Moon = session();

  Moon.Model.addInvestment({ name: "BTC", kind: "crypto", quantity: 5000, unitCost: 24500, unitPrice: 31200, priceDate: "2026-09-02" });
  Moon.Model.addInvestment({ name: "THYAO", kind: "stock", quantity: 10000, unitCost: 30000, unitPrice: 24000, priceDate: "2026-09-02" });
  Moon.Model.addInvestment({ name: "ASELS", kind: "stock", quantity: 20000, unitCost: 5000, unitPrice: 6000, priceDate: "2026-09-02" });
  Moon.Model.addInvestment({ name: "Kapalı", kind: "gold", quantity: 10000, unitCost: 1, unitPrice: 900000, priceDate: "2026-09-02", archived: true });

  const totals = Moon.Model.investmentTotals();
  assert.equal(totals.count, 3, "an archived holding is off the screen and out of the total");
  assert.equal(totals.value, 15600 + 24000 + 12000);
  assert.equal(totals.cost, 12250 + 30000 + 10000);
  assert.equal(totals.gain, totals.value - totals.cost);
  assert.equal(totals.byKind.gold, undefined);

  /* Two holdings of one kind are one segment. */
  assert.equal(totals.byKind.stock.count, 2);
  assert.equal(totals.byKind.stock.value, 36000);
  assert.equal(totals.byKind.stock.cost, 40000);
  assert.equal(totals.byKind.stock.gain, -4000);
  assert.equal(totals.byKind.crypto.value, 15600);

  /* kinds holds the same objects, widest first, so the stacked bar and the
     legend under it cannot order or round the same number differently. */
  assert.equal(totals.kinds.length, 2);
  assert.equal(totals.kinds[0], totals.byKind.stock);
  assert.equal(totals.kinds[1], totals.byKind.crypto);
  assert.deepEqual(Array.from(totals.kinds.map((group) => group.kind)), ["stock", "crypto"]);

  /* share is a whole percent of the total value, the figure
     investments.byKind.row prints. */
  assert.equal(totals.kinds[0].share, Math.round((36000 / totals.value) * 100));
  assert.equal(totals.kinds[0].share + totals.kinds[1].share, 100);

  /* An empty portfolio is zeros and an empty legend, with no ratio invented
     out of a cost of nothing. */
  const empty = session().Model.investmentTotals();
  assert.equal(empty.value, 0);
  assert.equal(empty.cost, 0);
  assert.equal(empty.gain, 0);
  assert.equal(empty.count, 0);
  assert.equal(empty.gainRatio, null);
  assert.deepEqual(plain(empty.kinds), []);
});

test("validateInvestment refuses a nameless holding, a fractional quantity and a missing price", () => {
  const Moon = session();

  assert.equal(Moon.Model.validateInvestment({ name: "", quantity: 5000, unitPrice: 100 }).errors.name,
    "err.nameRequired");

  /* The view hands over the integer parseQuantity returned, so a fraction
     arriving here is a caller that skipped the parser rather than a reader who
     typed badly. */
  for (const quantity of [0.5, -5000, "", null, "yarım"]) {
    const verdict = Moon.Model.validateInvestment({ name: "BTC", quantity, unitPrice: 100 });
    assert.equal(verdict.ok, false, JSON.stringify(quantity));
    assert.equal(verdict.errors.quantity, "err.quantityInvalid");
  }
  /* A position of nothing is a holding the reader sold and still wants to watch
     the price of, not a broken record. */
  assert.equal(Moon.Model.validateInvestment({ name: "BTC", quantity: 0, unitPrice: 100 }).ok, true);

  assert.equal(Moon.Model.validateInvestment({ name: "BTC", quantity: 5000 }).errors.unitPrice,
    "err.priceRequired");
  assert.equal(Moon.Model.validateInvestment({ name: "BTC", quantity: 5000, unitPrice: "pahalı" }).errors.unitPrice,
    "err.badAmount");
  assert.equal(Moon.Model.addInvestment({ name: "BTC", quantity: 5000 }), null);
  assert.equal(Moon.Model.investments().length, 0, "a refused draft writes nothing");

  /* §3.3 admits seven kinds; an unknown one is dealt back to "other" so the
     record that reaches the store is always one of them. */
  const id = Moon.Model.addInvestment({ name: "Tarla", kind: "farmland", quantity: 10000, unitPrice: 100 });
  const record = Moon.Model.investmentById(id);
  assert.equal(record.kind, "other");
  assert.ok(Moon.Store.INVESTMENT_KINDS.includes(record.kind));

  /* removeInvestment hands back the record, not an id: investments.removed
     needs the name and the holding is gone by then. */
  const removed = Moon.Model.removeInvestment(id);
  assert.equal(removed.name, "Tarla");
  assert.equal(Moon.Model.investmentById(id), null);
  assert.equal(Moon.Model.removeInvestment(id), null);
});
