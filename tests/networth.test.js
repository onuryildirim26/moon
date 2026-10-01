/* The net-worth card is the first number the reader sees, and §4 asks two
 * things of it that pull in opposite directions: it must add up the whole
 * install — accounts, holdings, what is owed to the reader and what the reader
 * owes — and it must never invent a figure. An install with nothing written
 * down yet gets a sentence, not a confident ₺0,00, which is why `measured`
 * exists alongside the seven amounts.
 *
 * Both halves are measured here, because a sum that is right and a zero that
 * lies would fail in the same silent way: the card would look finished.
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

/* A booted session with the seed install's records cleared, so a figure in the
 * card came from this test rather than from the install's own categories. The
 * day is pinned so period arithmetic reads the same whenever this suite runs. */
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

test("net worth adds the accounts, the holdings and both directions of debt", () => {
  const Moon = session();
  const category = Moon.Store.state.categories.find((one) => one.kind === "expense").id;

  const bank = Moon.Model.addAccount({ name: "Garanti", kind: "bank", opening: 500000 });
  Moon.Model.addAccount({ name: "Kart", kind: "card", opening: -120000 });
  Moon.Model.addEntry({ date: "2026-09-10", amount: 60000, direction: "out", categoryId: category, accountId: bank });

  Moon.Model.addInvestment({
    name: "Gram", kind: "gold", quantity: 20000, unitCost: 300000, unitPrice: 320000, priceDate: "2026-09-01"
  });
  Moon.Model.addDebt({ person: "Ali", amount: 75000, direction: "owedToMe", date: "2026-09-01" });
  Moon.Model.addDebt({ person: "Banka", amount: 200000, direction: "iOwe", date: "2026-09-01" });

  const worth = Moon.Model.netWorth();
  /* 500.000 less the 60.000 spent, plus a card sitting at −120.000: a negative
     balance stays inside `cash` rather than crossing over to liabilities. */
  assert.equal(worth.cash, 440000 - 120000);
  assert.equal(worth.investments, 640000);
  assert.equal(worth.owedToMe, 75000);
  assert.equal(worth.iOwe, 200000);

  assert.equal(worth.assets, worth.cash + worth.investments + worth.owedToMe);
  assert.equal(worth.liabilities, worth.iOwe);
  assert.equal(worth.total, worth.assets - worth.liabilities);
  assert.equal(worth.total, 320000 + 640000 + 75000 - 200000);

  assert.equal(worth.measured, true);
  assert.deepEqual(plainCounts(worth.counts), { accounts: 2, investments: 1, debts: 2 });

  /* The three sources must be the same numbers the sections themselves print,
     or the card and the screen below it disagree. */
  assert.equal(worth.cash, Moon.Model.accountTotals().total);
  assert.equal(worth.investments, Moon.Model.investmentTotals().value);
  assert.equal(worth.owedToMe, Moon.Model.debtTotals().owedToMe);

  for (const figure of [worth.cash, worth.investments, worth.owedToMe, worth.iOwe,
    worth.assets, worth.liabilities, worth.total]) {
    assert.ok(Number.isInteger(figure), `${figure} must be an integer of minor units`);
  }
});

test("an install with nothing written down reads as zeros and says it measured nothing", () => {
  const Moon = session();
  const worth = Moon.Model.netWorth();

  for (const field of ["cash", "investments", "owedToMe", "iOwe", "assets", "liabilities", "total"]) {
    assert.equal(worth[field], 0, field);
  }
  /* This is the whole point of the flag: zeros that nobody measured are worth a
     sentence, and the view cannot tell this case from a real net worth of zero
     out of the seven amounts alone. */
  assert.equal(worth.measured, false);
  assert.deepEqual(plainCounts(worth.counts), { accounts: 0, investments: 0, debts: 0 });
});

test("net worth does not throw when the collections are not there at all", () => {
  /* No boot, so Store.state is null and every collection is missing rather than
     empty — the shape a page assembled in the wrong order would hand over, and
     a read that threw here would blank the panel instead of one card. */
  const Moon = load().Moon;
  assert.equal(Moon.Store.state, null);

  const worth = Moon.Model.netWorth();
  assert.equal(worth.total, 0);
  assert.equal(worth.assets, 0);
  assert.equal(worth.liabilities, 0);
  assert.equal(worth.measured, false);
  assert.equal(Moon.Model.accountTotals().total, 0);
  assert.equal(Moon.Model.investmentTotals().value, 0);
});

test("debts with no accounts and no holdings still count as measured", () => {
  const Moon = session();
  Moon.Model.addDebt({ person: "Ali", amount: 75000, direction: "owedToMe", date: "2026-09-01" });
  Moon.Model.addDebt({ person: "Banka", amount: 200000, direction: "iOwe", date: "2026-09-01" });

  const worth = Moon.Model.netWorth();
  assert.equal(worth.cash, 0);
  assert.equal(worth.investments, 0);
  assert.equal(worth.assets, 75000);
  assert.equal(worth.liabilities, 200000);
  /* A reader who owes more than they are owed has a negative net worth, and it
     is a measured one. */
  assert.equal(worth.total, -125000);
  assert.equal(worth.measured, true);
  assert.equal(worth.counts.accounts, 0);
  assert.equal(worth.counts.debts, 2);
});

test("a settled debt is out of the sum and out of the count", () => {
  const Moon = session();
  const open = Moon.Model.addDebt({ person: "Ali", amount: 75000, direction: "owedToMe", date: "2026-09-01" });
  const paid = Moon.Model.addDebt({ person: "Veli", amount: 999999, direction: "owedToMe", date: "2026-08-01" });
  const forgiven = Moon.Model.addDebt({ person: "Banka", amount: 450000, direction: "iOwe", date: "2026-08-01" });
  Moon.Model.settleDebt(paid, "2026-09-02");
  Moon.Model.settleDebt(forgiven, "2026-09-02");

  const worth = Moon.Model.netWorth();
  assert.equal(worth.owedToMe, 75000);
  assert.equal(worth.iOwe, 0);
  assert.equal(worth.total, 75000);
  assert.equal(worth.counts.debts, 1, "counts.debts counts the open debts only");

  /* Once the last open debt is settled there is nothing measured again, which
     is what sends the card back to its sentence. */
  Moon.Model.settleDebt(open, "2026-09-03");
  const after = Moon.Model.netWorth();
  assert.equal(after.total, 0);
  assert.equal(after.measured, false);
  assert.equal(after.counts.debts, 0);
});

test("an archived account or holding is out of every total", () => {
  const Moon = session();
  Moon.Model.addAccount({ name: "Cüzdan", kind: "cash", opening: 100000 });
  Moon.Model.addAccount({ name: "Kapalı", kind: "savings", opening: 900000, archived: true });
  Moon.Model.addInvestment({
    name: "Satılan", kind: "stock", quantity: 10000, unitCost: 1, unitPrice: 777000,
    priceDate: "2026-09-01", archived: true
  });

  const worth = Moon.Model.netWorth();
  /* The card has to equal the sum of what is on the screen under it, and a
     closed account is not on the screen. */
  assert.equal(worth.cash, 100000);
  assert.equal(worth.investments, 0);
  assert.equal(worth.total, 100000);
  assert.equal(worth.counts.accounts, 1);
  assert.equal(worth.counts.investments, 0);
});

/* counts is built inside the vm, so comparing it as an object needs its own
 * copy on this side; the three fields are plain integers. */
function plainCounts(counts) {
  return { accounts: counts.accounts, investments: counts.investments, debts: counts.debts };
}

/* Money in two currencies.
 *
 * Before this existed, a dollar account and a lira account were added together
 * as though both were the same integer, because both ARE the same integer once
 * the currency is dropped. The total that came out was not wrong by a rounding
 * error, it was wrong by the exchange rate — and nothing on the screen looked
 * broken, which is the kind of wrong nobody catches. */
test("a balance in another currency is left out until a rate is typed", () => {
  const Moon = session();

  Moon.Model.addAccount({ name: "Lira", kind: "bank", opening: 10000000, currency: "TRY" });
  Moon.Model.addAccount({ name: "Dollars", kind: "savings", opening: 250000, currency: "USD" });

  const before = Moon.Model.netWorth();
  assert.equal(before.total, 10000000, "only what could be converted is in the total");
  assert.deepEqual(Array.from(before.unconverted), ["USD"],
    "and the currency that could not be is named rather than dropped silently");
  assert.deepEqual(Array.from(Moon.Model.rates().missing), ["USD"]);

  /* 1 USD = 41,50 ₺, as the reader would type it. */
  Moon.Model.setRate("USD", 4150);

  const after = Moon.Model.netWorth();
  assert.deepEqual(Array.from(after.unconverted), []);
  assert.equal(after.total - before.total, Math.round(250000 * 4150 / 100),
    "the dollars join at exactly the rate that was typed");
  assert.equal(after.total, 20375000);
});

test("rates stop applying when the app is set to report in something else", () => {
  const Moon = session();
  Moon.Model.addAccount({ name: "Dollars", kind: "savings", opening: 100000, currency: "USD" });
  Moon.Model.setRate("USD", 4150);
  assert.equal(Moon.Model.netWorth().total, 4150000);

  /* The rate means "this many minor units of the base". Switch what the app
     reports in and the stored number no longer describes what it claims to:
     reusing it would read 1 USD as 41,50 EUR. It is refused, and the dollars go
     back to being unconverted until a rate in the new base is typed. */
  Moon.Store.update((draft) => { draft.settings.currency = "EUR"; }, { immediate: true });

  const after = Moon.Model.netWorth();
  assert.equal(after.currency, "EUR");
  assert.equal(after.total, 0, "nothing is converted on a rate that meant another base");
  assert.deepEqual(Array.from(after.unconverted), ["USD"]);
});

test("a holding priced in another currency follows the same rule", () => {
  const Moon = session();
  Moon.Model.addInvestment({
    name: "A fund", kind: "fund", quantity: 10000, unitCost: 10000,
    unitPrice: 12000, currency: "USD"
  });

  assert.deepEqual(Array.from(Moon.Model.investmentTotals().unconverted), ["USD"]);
  assert.equal(Moon.Model.investmentTotals().value, 0);

  Moon.Model.setRate("USD", 4000);
  const totals = Moon.Model.investmentTotals();
  assert.deepEqual(Array.from(totals.unconverted), []);
  /* One unit at 120,00 USD, at 40,00 ₺ to the dollar. */
  assert.equal(totals.value, Math.round(12000 * 4000 / 100));
});
