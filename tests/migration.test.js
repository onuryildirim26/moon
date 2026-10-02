/* Schema version 2 is the first migration this app has ever run on somebody
 * else's data, and the install it runs on is the only copy of that data there
 * is. §3.1 therefore asks three things of it: the two new collections appear,
 * every category comes out dressed in a colour and an icon, and nothing the
 * blob already carried is lost — including fields this version has never heard
 * of, which a newer Moon or another device may have written.
 *
 * It also has to be safe to run twice. The same bytes reach a second tab, and a
 * synced folder can hand them to a second device, so the step is written to be
 * idempotent and that is what is measured rather than assumed.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

/* load.js hands back the vm context itself, and that context is what each of
 * Moon's files is given as `window`, so a shim assigned onto it is the
 * localStorage store.js resolves when boot() asks for one. Seeding it is how a
 * test plays "this reader already had Moon installed". */
class MemoryStorage {
  constructor(seed) { this.map = new Map(Object.entries(seed || {})); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

function session(seed, today = "2026-09-21") {
  const sandbox = load();
  sandbox.localStorage = new MemoryStorage(seed);
  const Moon = sandbox.Moon;
  Moon.Dates.today = () => today;
  return Moon;
}

/* A migration step edits the blob in place and the arrays it adds are built
 * inside the vm, so they carry that realm's prototypes and a strict deep
 * compare against a host array fails on identical contents. A JSON round trip
 * brings the whole graph over, and it is lossless here because the blob is a
 * JSON document by definition — it came out of localStorage. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/* What Moon 1 actually wrote: no accounts, no investments, categories with
 * neither colour nor icon. The three `mystery`/`extra`/`unknownTop` fields
 * stand in for whatever a newer version put there — the thing §3.1 promises
 * survives. */
function v1Blob() {
  return {
    schemaVersion: 1,
    createdAt: "2026-01-05",
    settings: { lang: "tr", currency: "TRY", monthStartDay: 1, unknownSetting: "kept" },
    unknownTop: { note: "written by a newer Moon" },
    categories: [
      { id: "c_rent", name: "Kira", kind: "expense", fixed: true, archived: false, mystery: 7 },
      { id: "c_groc", name: "Market", kind: "expense", fixed: false, archived: false },
      { id: "c_sal", name: "Maaş", kind: "income", fixed: false, archived: false }
    ],
    entries: [
      { id: "e1", date: "2026-01-10", amount: 180000, direction: "out", categoryId: "c_rent", note: "", extra: "x" }
    ],
    limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
    recurring: [],
    goals: [],
    debts: []
  };
}

test("a v1 blob gains both collections and arrives at schema version 2", () => {
  const Moon = session();
  const migrated = Moon.Store.MIGRATIONS[1](v1Blob());

  /* MIGRATIONS[1] is one rung, not the ladder: it carries v1 to v2 and stops.
     Whether later rungs exist is a different question, asked further down. */
  assert.equal(migrated.schemaVersion, 2);
  assert.ok(Array.isArray(migrated.accounts), "accounts must exist after the step");
  assert.ok(Array.isArray(migrated.investments), "investments must exist after the step");
  assert.deepEqual(plain(migrated.accounts), []);
  assert.deepEqual(plain(migrated.investments), []);
});

test("running the migration twice leaves exactly the same document", () => {
  const Moon = session();
  const once = plain(Moon.Store.MIGRATIONS[1](v1Blob()));
  /* The second run is given the output of the first, as a second tab or a
     synced folder would hand it over. */
  const twice = plain(Moon.Store.MIGRATIONS[1](plain(once)));
  assert.deepEqual(twice, once);

  /* And a third time, because an idempotent step that is only idempotent once
     is a step that counts rather than one that checks. */
  assert.deepEqual(plain(Moon.Store.MIGRATIONS[1](plain(twice))), once);
});

test("nothing the blob already carried is dropped on the way through", () => {
  const Moon = session();
  const before = v1Blob();
  const after = plain(Moon.Store.MIGRATIONS[1](plain(before)));

  /* A top-level key this version has never heard of. */
  assert.deepEqual(after.unknownTop, { note: "written by a newer Moon" });
  assert.equal(after.settings.unknownSetting, "kept");
  assert.equal(after.createdAt, "2026-01-05");

  /* And a field on a single record, which is where a rebuilt-field-by-field
     migration would lose things. */
  assert.equal(after.categories.find((one) => one.id === "c_rent").mystery, 7);
  assert.equal(after.entries[0].extra, "x");
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.limits, before.limits);
  assert.equal(after.categories.length, before.categories.length);
  for (const category of before.categories) {
    const moved = after.categories.find((one) => one.id === category.id);
    assert.equal(moved.name, category.name);
    assert.equal(moved.kind, category.kind);
    assert.equal(moved.fixed, category.fixed);
  }
});

test("every migrated category comes out with a colour and an icon", () => {
  const Moon = session();
  const after = plain(Moon.Store.MIGRATIONS[1](v1Blob()));

  for (const category of after.categories) {
    assert.match(category.color, /^#[0-9A-F]{6}$/,
      `${category.id} needs a spectrum colour, got ${JSON.stringify(category.color)}`);
    assert.ok(Moon.Store.CATEGORY_SPECTRUM.includes(category.color), category.color);
    assert.equal(typeof category.icon, "string");
    assert.notEqual(category.icon, "", `${category.id} must never be left without an icon`);
  }

  /* Dealt by position, so a list of categories is a list of different colours
     rather than one colour repeated. */
  assert.equal(after.categories[0].color, Moon.Store.CATEGORY_SPECTRUM[0]);
  assert.equal(after.categories[1].color, Moon.Store.CATEGORY_SPECTRUM[1]);
  assert.equal(new Set(after.categories.map((one) => one.color)).size, after.categories.length);

  /* The icon follows the kind, with §3.1's fallback for anything else. */
  assert.equal(after.categories.find((one) => one.kind === "expense").icon,
    Moon.Store.ICON_BY_KIND.expense);
  assert.equal(after.categories.find((one) => one.kind === "income").icon,
    Moon.Store.ICON_BY_KIND.income);

  const odd = plain(Moon.Store.MIGRATIONS[1]({
    schemaVersion: 1,
    categories: [{ id: "c_odd", name: "Tuhaf", kind: "sideways" }]
  }));
  assert.equal(odd.categories[0].icon, Moon.Store.FALLBACK_ICON);
  assert.notEqual(odd.categories[0].icon, "");

  /* A colour the reader already picked is theirs and is kept. */
  const chosen = plain(Moon.Store.MIGRATIONS[1]({
    schemaVersion: 1,
    categories: [{ id: "c_mine", name: "Benim", kind: "expense", color: "#FF6FD8", icon: "🎈" }]
  }));
  assert.equal(chosen.categories[0].color, "#FF6FD8");
  assert.equal(chosen.categories[0].icon, "🎈");
});

test("a stored v1 install migrates when it is booted", () => {
  const stored = v1Blob();
  const Moon = session({ "moon.v1": JSON.stringify(stored) });
  const result = Moon.Store.boot();

  assert.equal(result.ok, true);
  assert.equal(result.reason, "migrated");
  assert.equal(result.dropped, 0, "a v1 install has nothing in it the v2 reader cannot read");

  const state = Moon.Store.state;
  assert.equal(state.schemaVersion, Moon.Store.SCHEMA_VERSION);
  assert.ok(Array.isArray(state.accounts));
  assert.ok(Array.isArray(state.investments));
  assert.deepEqual(plain(state.unknownTop), { note: "written by a newer Moon" });
  assert.equal(state.categories.find((one) => one.id === "c_rent").mystery, 7);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].extra, "x");
  for (const category of state.categories) {
    assert.notEqual(category.color, "");
    assert.notEqual(category.icon, "");
  }

  /* The migrated install is what the sections now read, and with no accounts
     and no holdings in it there is still nothing to measure. */
  assert.equal(Moon.Model.netWorth().measured, false);
  assert.equal(Moon.Model.accounts().length, 0);
  assert.equal(Moon.Model.investments().length, 0);
});

test("a v2 install is not damaged by being read again", () => {
  /* Complete records, because the point of this check is that a sound document
     passes through untouched — a half-written one would be repaired, which is a
     different promise. */
  const stored = {
    schemaVersion: 2,
    createdAt: "2026-01-05",
    settings: { lang: "tr", currency: "TRY", monthStartDay: 1, theme: "dial", overflowMark: "pigment", changesSinceBackup: 0 },
    categories: [
      { id: "c_rent", name: "Kira", kind: "expense", fixed: true, archived: false, color: "#8AA6FF", icon: "🧾" }
    ],
    entries: [],
    limits: [],
    recurring: [],
    goals: [],
    debts: [],
    accounts: [
      { id: "a_bank", name: "Garanti", kind: "bank", opening: 100000, currency: "TRY", color: "#3DD6A0", icon: "🏦", archived: false, createdAt: "2026-01-05" }
    ],
    investments: [
      {
        id: "i_gold", name: "Gram", kind: "gold", quantity: 20000, unitCost: 300000,
        unitPrice: 320000, priceDate: "2026-02-01", currency: "TRY", note: "",
        color: "#FFB454", icon: "🥇", archived: false, createdAt: "2026-01-05",
        history: [{ date: "2026-02-01", unitPrice: 320000 }]
      }
    ]
  };

  const Moon = session({ "moon.v1": JSON.stringify(stored) });
  const result = Moon.Store.boot();

  /* v2 is no longer the top of the ladder, so opening one is a migration — and
     the point of this test is that it is a migration which COSTS NOTHING: every
     record it already held comes back exactly as written. */
  assert.equal(result.reason, "migrated");
  assert.equal(result.repaired, 0, "a clean v2 document needs no repair on the way up");
  assert.equal(result.dropped, 0, "and loses nothing");
  assert.ok(Array.isArray(Moon.Store.state.transfers), "the new collection arrives empty");

  const state = Moon.Store.state;
  assert.equal(state.schemaVersion, Moon.Store.SCHEMA_VERSION);
  assert.deepEqual(plain(state.categories), stored.categories);
  assert.deepEqual(plain(state.accounts), stored.accounts);
  assert.deepEqual(plain(state.investments), stored.investments);

  /* Read back through the model the records still say what they said. */
  assert.equal(Moon.Model.accountBalance("a_bank"), 100000);
  assert.equal(Moon.Model.investmentTotals().value, 640000);
});

test("a collection that is present but is not a list is left alone, not replaced", () => {
  const Moon = session();
  /* Replacing it with an empty list would be a silent loss. Leaving it is what
     lets normalize count it and the caller copy the bytes aside first. */
  const after = Moon.Store.MIGRATIONS[1]({
    schemaVersion: 1,
    accounts: "not-a-list",
    categories: "not-a-list"
  });
  assert.equal(after.accounts, "not-a-list");
  assert.equal(after.categories, "not-a-list");
  assert.equal(after.schemaVersion, 2);
  assert.ok(Array.isArray(after.investments), "the collection that was missing is still added");
});

/* The ladder as a whole, rather than any one rung of it. This is the test that
   should have been here before: it does not name a version, so the next
   migration cannot make it fail while it is still describing the truth. */
test("a document already at the top is read, not migrated", () => {
  const Moon = session();
  const top = Moon.Store.SCHEMA_VERSION;

  Moon.Store.boot();
  const fresh = JSON.parse(JSON.stringify(Moon.Store.state));
  const again = session({ "moon.v1": JSON.stringify(fresh) });
  const result = again.Store.boot();

  assert.equal(fresh.schemaVersion, top, "a new install is written at the current version");
  assert.equal(result.reason, "loaded", "and opening it again is not a migration");
  assert.equal(again.Store.state.schemaVersion, top);
});

test("a v1 blob climbs every rung when it is booted, not just the first", () => {
  const Moon = session({ "moon.v1": JSON.stringify(v1Blob()) });
  const result = Moon.Store.boot();

  assert.equal(result.reason, "migrated");
  assert.equal(Moon.Store.state.schemaVersion, Moon.Store.SCHEMA_VERSION,
    "boot runs the ladder to the top, however many rungs it grows");
  /* Every collection any rung has ever added is present at the end. */
  for (const name of ["accounts", "investments", "transfers"]) {
    assert.ok(Array.isArray(Moon.Store.state[name]), `${name} must exist after the climb`);
  }
});
