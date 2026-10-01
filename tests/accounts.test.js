/* §3.2 makes one arithmetic promise about an account — its balance is the
 * opening figure plus what came in, less what went out — and two promises
 * around it: an entry with no account still counts everywhere it counted
 * before, and deleting an account costs its entries their link and nothing
 * else. All three are the kind of thing that looks obviously right in the
 * source and is quietly wrong on the screen, so they are measured here.
 *
 * The checks run against the real store rather than a fixture document. A
 * record the model writes in a shape store.js would then repair reads back
 * differently from how it was written, and only going through the store at all
 * would show that.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

/* load.js hands back the vm context itself, and that context is what each of
 * Moon's files is given as `window`, so a shim assigned onto it is the
 * localStorage store.js resolves when boot() asks for one. Nothing in this
 * suite touches the real disk. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

/* A booted session with the seed install's records cleared, so every figure a
 * test asserts comes from the records that test wrote. The day is pinned
 * because period arithmetic run on the 30th must not read differently when the
 * same test runs on the 1st. */
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

/* The seed categories are the install's own, so a test spends through whichever
 * of them happens to be first rather than inventing a category and having to
 * keep its shape up to date. */
function categoryIds(Moon) {
  const all = Moon.Store.state.categories;
  return {
    expense: all.find((category) => category.kind === "expense").id,
    income: all.find((category) => category.kind === "income").id
  };
}

test("a balance is the opening figure plus what came in, less what went out", () => {
  const Moon = session();
  const category = categoryIds(Moon);

  const bank = Moon.Model.addAccount({ name: "Garanti", kind: "bank", opening: 100000 });
  const other = Moon.Model.addAccount({ name: "Cüzdan", kind: "cash", opening: 7000 });

  Moon.Model.addEntry({ date: "2026-09-11", amount: 50000, direction: "in", categoryId: category.income, accountId: bank });
  Moon.Model.addEntry({ date: "2026-09-12", amount: 25000, direction: "out", categoryId: category.expense, accountId: bank });
  /* An entry the reader never attached to anything, and one attached to the
     other account: §3.2 says the account is extra information, so neither of
     these may move the bank's balance. */
  Moon.Model.addEntry({ date: "2026-09-13", amount: 9900, direction: "out", categoryId: category.expense });
  Moon.Model.addEntry({ date: "2026-09-14", amount: 4000, direction: "out", categoryId: category.expense, accountId: other });

  assert.equal(Moon.Model.accountBalance(bank), 125000);
  assert.equal(Moon.Model.accountBalance(other), 3000);

  /* The unassigned entry still spends: it is absent from the balances above and
     present in the period's outgoings. */
  assert.equal(Moon.Model.periodSummary("2026-09").spentTotal, 25000 + 9900 + 4000);
});

test("a credit card starts the month owing money and goes further down as it is used", () => {
  const Moon = session();
  const category = categoryIds(Moon);

  const card = Moon.Model.addAccount({ name: "Kart", kind: "card", opening: -120000 });
  assert.equal(Moon.Model.accountBalance(card), -120000);

  Moon.Model.addEntry({ date: "2026-09-05", amount: 30000, direction: "out", categoryId: category.expense, accountId: card });
  assert.equal(Moon.Model.accountBalance(card), -150000);

  /* Paying it down moves the balance towards zero without ever making a card's
     negative balance an error in itself. */
  Moon.Model.addEntry({ date: "2026-09-20", amount: 50000, direction: "in", categoryId: category.income, accountId: card });
  assert.equal(Moon.Model.accountBalance(card), -100000);
});

test("deleting an account detaches its entries and deletes none of them", () => {
  const Moon = session();
  const category = categoryIds(Moon);

  const bank = Moon.Model.addAccount({ name: "Garanti", kind: "bank", opening: 100000 });
  const other = Moon.Model.addAccount({ name: "Cüzdan", kind: "cash", opening: 0 });

  const kept = [
    Moon.Model.addEntry({ date: "2026-09-11", amount: 50000, direction: "in", categoryId: category.income, accountId: bank }),
    Moon.Model.addEntry({ date: "2026-09-12", amount: 25000, direction: "out", categoryId: category.expense, accountId: bank }),
    Moon.Model.addEntry({ date: "2026-09-13", amount: 9900, direction: "out", categoryId: category.expense })
  ];
  const elsewhere = Moon.Model.addEntry({
    date: "2026-09-14", amount: 4000, direction: "out", categoryId: category.expense, accountId: other
  });
  const before = Moon.Store.state.entries.length;

  const result = Moon.Model.removeAccount(bank);
  /* The return is { record, detached } rather than an id, because
     accounts.removed needs both the name and a count the view cannot work out
     for itself once the account is gone. */
  assert.equal(result.record.name, "Garanti");
  assert.equal(result.detached, 2);
  assert.equal(Moon.Model.accountById(bank), null);

  assert.equal(Moon.Store.state.entries.length, before,
    "removing an account must not remove an entry");

  const byId = new Map(Moon.Store.state.entries.map((entry) => [entry.id, entry]));
  for (const id of kept) {
    assert.ok(byId.has(id), `entry ${id} should still be in the ledger`);
    assert.equal(byId.get(id).accountId, null);
  }
  /* The amounts are the reader's own figures and the deletion was about the
     account, so nothing about the entry itself may have moved. */
  assert.equal(byId.get(kept[0]).amount, 50000);
  assert.equal(byId.get(kept[0]).direction, "in");
  assert.equal(byId.get(kept[1]).date, "2026-09-12");
  /* The other account's entry keeps its link: only the deleted account's rows
     are detached. */
  assert.equal(byId.get(elsewhere).accountId, other);
  assert.equal(Moon.Model.accountBalance(other), -4000);

  assert.equal(Moon.Model.removeAccount(bank), null, "a second delete has nothing to delete");
});

test("validateAccount refuses a nameless account and an opening it cannot read", () => {
  const Moon = session();

  for (const name of ["", "   ", null, undefined]) {
    const verdict = Moon.Model.validateAccount({ name });
    assert.equal(verdict.ok, false, `name ${JSON.stringify(name)} should be refused`);
    assert.equal(verdict.errors.name, "err.nameRequired");
    assert.equal(Moon.Model.addAccount({ name }), null);
  }

  const unreadable = Moon.Model.validateAccount({ name: "Garanti", opening: "beş lira" });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.errors.opening, "err.badAmount");
  assert.equal(Moon.Model.addAccount({ name: "Garanti", opening: "beş lira" }), null);
  assert.equal(Moon.Model.accounts().length, 0, "a refused draft writes nothing");

  /* An omitted opening is not a refusal: most accounts are added mid-month with
     whatever is in them today, and a reader who does not know the figure should
     not be stopped by it. */
  assert.equal(Moon.Model.validateAccount({ name: "Garanti" }).ok, true);
  const id = Moon.Model.addAccount({ name: "Garanti" });
  assert.equal(Moon.Model.accountById(id).opening, 0);
});

test("a stored account always carries one of §3.2's four kinds and an integer opening", () => {
  const Moon = session();

  /* §3.2 admits exactly four kinds, and the model keeps that promise by dealing
     an unknown one back to "cash" rather than by refusing the draft. The record
     that reaches the store is what the schema is about, so that is what is
     measured here. */
  const id = Moon.Model.addAccount({ name: "Hayali", kind: "crypto", opening: 1000 });
  assert.notEqual(id, null);
  const record = Moon.Model.accountById(id);
  assert.equal(record.kind, "cash");
  assert.ok(Moon.Store.ACCOUNT_KINDS.includes(record.kind));

  /* Likewise an opening that is readable but is not whole: the schema says
     integer minor units, so a fraction may not survive the write. */
  const rounded = Moon.Model.addAccount({ name: "Kuruş", opening: 1500.5 });
  assert.ok(Number.isInteger(Moon.Model.accountById(rounded).opening));

  for (const kind of Moon.Store.ACCOUNT_KINDS) {
    const each = Moon.Model.addAccount({ name: "Hesap " + kind, kind });
    assert.equal(Moon.Model.accountById(each).kind, kind);
  }
});

test("accountTotals sums the unarchived accounts and nothing else", () => {
  const Moon = session();
  const category = categoryIds(Moon);

  const cash = Moon.Model.addAccount({ name: "Cüzdan", kind: "cash", opening: 100000 });
  const card = Moon.Model.addAccount({ name: "Kart", kind: "card", opening: -280000 });
  Moon.Model.addAccount({ name: "Kapalı", kind: "savings", opening: 900000, archived: true });

  Moon.Model.addEntry({ date: "2026-09-10", amount: 20000, direction: "out", categoryId: category.expense, accountId: cash });
  /* An entry on no account at all must stay out of the total, exactly as it
     stays out of each balance. */
  Moon.Model.addEntry({ date: "2026-09-10", amount: 55000, direction: "out", categoryId: category.expense });

  const totals = Moon.Model.accountTotals();
  assert.equal(totals.count, 2);
  assert.equal(totals.total, 80000 + -280000);
  assert.equal(totals.byKind.cash, 80000);
  assert.equal(totals.byKind.card, -280000);
  assert.equal(totals.byKind.savings, undefined,
    "an archived account's kind must not appear at all");

  /* The total above the cards has to equal the sum of the cards under it, which
     is only true while accounts() and accountTotals() agree on who is in. */
  const visible = Moon.Model.accounts();
  assert.equal(visible.length, totals.count);
  assert.equal(
    visible.reduce((sum, account) => sum + Moon.Model.accountBalance(account.id), 0),
    totals.total
  );
  assert.equal(Moon.Model.accounts({ all: true }).length, 3);
  assert.equal(Moon.Model.accounts({ kind: "card" }).length, 1);
});

test("accountFlow reports what moved through one account in one period", () => {
  const Moon = session();
  const category = categoryIds(Moon);

  const bank = Moon.Model.addAccount({ name: "Garanti", kind: "bank", opening: 100000 });
  const other = Moon.Model.addAccount({ name: "Cüzdan", kind: "cash", opening: 0 });
  Moon.Model.addEntry({ date: "2026-09-11", amount: 50000, direction: "in", categoryId: category.income, accountId: bank });
  Moon.Model.addEntry({ date: "2026-09-12", amount: 25000, direction: "out", categoryId: category.expense, accountId: bank });
  Moon.Model.addEntry({ date: "2026-08-30", amount: 70000, direction: "out", categoryId: category.expense, accountId: bank });
  Moon.Model.addEntry({ date: "2026-09-13", amount: 4000, direction: "out", categoryId: category.expense, accountId: other });

  const flow = Moon.Model.accountFlow(bank, "2026-09");
  assert.equal(flow.in, 50000);
  assert.equal(flow.out, 25000);
  assert.equal(flow.count, 2, "neither last month's entry nor another account's is counted");

  /* count === 0 is what tells the view to print accounts.flow.none instead of
     an honest-looking "0 in, 0 out". */
  assert.equal(Moon.Model.accountFlow(other, "2026-08").count, 0);
  assert.equal(Moon.Model.accountFlow(bank, "2026-08").out, 70000);
});

test("an id that names no account reads as nothing rather than throwing", () => {
  const Moon = session();
  assert.equal(Moon.Model.accountById("a_nope"), null);
  assert.equal(Moon.Model.accountBalance("a_nope"), 0);
  assert.equal(Moon.Model.accountBalance(null), 0);
  assert.equal(Moon.Model.removeAccount("a_nope"), null);
  assert.equal(Moon.Model.updateAccount("a_nope", { name: "X" }), null);
  assert.equal(Moon.Model.accountFlow("a_nope", "2026-09").count, 0);
});
