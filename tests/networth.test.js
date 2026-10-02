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

/* Moving money between two of your own accounts.
 *
 * The whole reason a transfer is its own collection rather than a pair of
 * entries: nothing that reads `entries` can mistake it for spending. Moving
 * five thousand lira into savings must not eat a month's budget, and it would
 * have looked entirely normal doing it. */
test("a transfer moves a balance without being spending or earning", () => {
  const Moon = session();
  const from = Moon.Model.addAccount({ name: "Current", kind: "bank", opening: 2000000 });
  const to = Moon.Model.addAccount({ name: "Savings", kind: "savings", opening: 0 });

  const before = {
    worth: Moon.Model.netWorth().total,
    spend: Moon.Model.periodSummary(Moon.Dates.periodKey("2026-09-21", 1)).spentTotal
  };

  const id = Moon.Model.addTransfer({
    date: "2026-09-21", amount: 500000, fromAccountId: from, toAccountId: to
  });
  assert.ok(id, "the transfer is written");

  assert.equal(Moon.Model.accountBalance(from), 1500000, "it left one account");
  assert.equal(Moon.Model.accountBalance(to), 500000, "and arrived in the other");

  const after = {
    worth: Moon.Model.netWorth().total,
    spend: Moon.Model.periodSummary(Moon.Dates.periodKey("2026-09-21", 1)).spentTotal
  };
  assert.equal(after.spend, before.spend, "it is not spending");
  assert.equal(after.worth, before.worth, "and money neither appeared nor vanished");

  Moon.Model.removeTransfer(id);
  assert.equal(Moon.Model.accountBalance(from), 2000000, "taking it back puts it back");
  assert.equal(Moon.Model.accountBalance(to), 0);
});

test("a transfer that cannot mean anything is refused", () => {
  const Moon = session();
  const a = Moon.Model.addAccount({ name: "A", kind: "cash", opening: 100000 });
  const b = Moon.Model.addAccount({ name: "B", kind: "cash", opening: 0 });

  const cases = [
    [{ date: "2026-09-21", amount: 1000, fromAccountId: a, toAccountId: a }, "to itself"],
    [{ date: "2026-09-21", amount: 0, fromAccountId: a, toAccountId: b }, "of nothing"],
    [{ date: "2026-09-21", amount: -500, fromAccountId: a, toAccountId: b }, "of a negative"],
    [{ date: "not-a-date", amount: 1000, fromAccountId: a, toAccountId: b }, "on no date"],
    [{ date: "2026-09-21", amount: 1000, fromAccountId: a, toAccountId: "nope" }, "to nowhere"],
  ];
  for (const [draft, why] of cases) {
    assert.equal(Moon.Model.addTransfer(draft), null, `a transfer ${why} is refused`);
  }
  assert.equal(Moon.Model.transfers().length, 0);
});

/* This is the one that was missing. A transfer only meets the store's own
   validator when it is written to disk and read back, so a mistake in that
   validator survives every test that only ever builds records in memory —
   which is exactly how a ReferenceError in it reached a browser. */
test("a transfer survives being written to disk and read back", () => {
  const Moon = session();
  const from = Moon.Model.addAccount({ name: "Current", kind: "bank", opening: 2000000 });
  const to = Moon.Model.addAccount({ name: "Savings", kind: "savings", opening: 0 });
  Moon.Model.addTransfer({
    date: "2026-09-21", amount: 500000, fromAccountId: from, toAccountId: to, note: "aylik birikim"
  });

  const text = Moon.Store.exportJson();
  assert.equal(JSON.parse(text).transfers.length, 1, "the export carries the collection");

  /* Imported into a session that has never seen it, which is the path that runs
     the store's own validator over every record. */
  const reopened = session();
  const result = reopened.Store.importJson(text, { mode: "replace" });
  assert.equal(result.ok, true, String(result.error));

  const rows = reopened.Model.transfers();
  assert.equal(rows.length, 1, "and the store's own validator keeps it on the way back in");
  assert.equal(rows[0].amount, 500000);
  assert.equal(rows[0].date, "2026-09-21");
  assert.equal(rows[0].note, "aylik birikim");
  assert.equal(reopened.Model.accountBalance(from), 1500000);
  assert.equal(reopened.Model.accountBalance(to), 500000);
});

/* Earning in two currencies at once, and switching what the app reports in.
 *
 * The bug this pins: a record used to hold a bare number, so changing the
 * display currency printed the same figure with a different symbol. 1.000,00 ₺
 * became 1.000,00 $ — not a conversion, a relabel, and the kind of wrong that
 * looks completely normal. A record now says what it was written in. */
test("changing the display currency converts the figures, it does not relabel them", () => {
  const Moon = session();
  const spend = Moon.Model.categories().filter((c) => c.kind === "expense")[0];
  const earn = Moon.Model.categories().filter((c) => c.kind === "income")[0];

  /* A thousand lira of spending, and a two thousand dollar salary paid into a
     dollar account — which is how someone earning in both is handled without
     being asked a single extra question. */
  Moon.Model.addEntry({
    date: "2026-09-21", amount: 100000, direction: "out", categoryId: spend.id
  });
  const usd = Moon.Model.addAccount({ name: "Dollars", kind: "bank", opening: 0, currency: "USD" });
  Moon.Model.addEntry({
    date: "2026-09-21", amount: 200000, direction: "in", categoryId: earn.id, accountId: usd
  });

  const period = Moon.Dates.periodKey("2026-09-21", 1);

  /* No rate yet: the dollars are left out and said out loud, rather than being
     added to the lira as though a dollar were a lira. */
  assert.equal(Moon.Model.periodSummary(period).income, 0);
  assert.deepEqual(Array.from(Moon.Model.rates().missing), ["USD"]);

  Moon.Model.setRate("USD", 4150);
  const inLira = Moon.Model.periodSummary(period);
  assert.equal(inLira.spentTotal, 100000, "the lira spending is itself");
  assert.equal(inLira.income, 8300000,
    "and the salary arrives at the rate that was typed: 2000 USD x 41,50");

  /* Now report in dollars instead. 1 TRY = 0,02 USD. */
  Moon.Store.update((draft) => { draft.settings.currency = "USD"; }, { immediate: true });
  Moon.Model.setRate("TRY", 2);

  const inDollars = Moon.Model.periodSummary(period);
  assert.equal(inDollars.spentTotal, 2000, "the same thousand lira is now twenty dollars");
  assert.equal(inDollars.income, 200000, "and the salary is the two thousand dollars it always was");
});

test("a record remembers what it was written in", () => {
  const Moon = session();
  const spend = Moon.Model.categories().filter((c) => c.kind === "expense")[0];

  const id = Moon.Model.addEntry({
    date: "2026-09-21", amount: 5000, direction: "out", categoryId: spend.id
  });
  const written = Moon.Model.entries({}).filter((e) => e.id === id)[0];
  assert.equal(written.currency, "TRY", "stamped at the moment of writing");

  /* An entry that belongs to an account takes the account's currency, because
     a dollar salary paid into a dollar account is a dollar salary. */
  const usd = Moon.Model.addAccount({ name: "Dollars", kind: "bank", opening: 0, currency: "USD" });
  const other = Moon.Model.addEntry({
    date: "2026-09-21", amount: 5000, direction: "out", categoryId: spend.id, accountId: usd
  });
  assert.equal(Moon.Model.entries({}).filter((e) => e.id === other)[0].currency, "USD");

  /* And it survives an edit, or the figure would silently change meaning. */
  Moon.Model.updateEntry(id, { amount: 7000 });
  assert.equal(Moon.Model.entries({}).filter((e) => e.id === id)[0].currency, "TRY");
});
