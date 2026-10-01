/* Moon — store: the one source of truth.
 *
 * Owns localStorage["moon.v1"] and nothing else. Every read the app does goes
 * through Store.state, every write through Store.update(mutator).
 *
 * Three promises this file keeps, in order of importance:
 *   1. User data is never destroyed silently. Unreadable data is MOVED aside
 *      (moon.v1.corrupt.<stamp>), never overwritten; a failed write leaves the
 *      in-memory change on screen and shouts through 'store:error'.
 *   2. The app keeps working without storage. A blocked localStorage (private
 *      window, Safari file://) degrades to a memory session, not a dead page.
 *   3. Forward compatibility. Unknown fields written by a newer Moon survive a
 *      round trip through this version untouched.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var KEY = "moon.v1";
  var BACKUP_KEY = "moon.v1.bak";
  var PROBE_KEY = "moon.probe";
  /* Written only by wipe(), read only by other tabs. See wipe(). */
  var WIPE_KEY = "moon.v1.wiped";
  var CORRUPT_PREFIX = "moon.v1.corrupt.";
  var SCHEMA_VERSION = 2;
  var WRITE_DELAY = 250;
  var NOTE_MAX = 200;
  var ACCOUNT_NAME_MAX = 60;
  var INVESTMENT_NAME_MAX = 80;
  /* One emoji is at most two surrogate pairs, which is what a flag or a keycap
     costs; anything longer is a label, and a label belongs in `name`. */
  var ICON_MAX = 4;
  /* A price a day for a year and a bit. The chart reads this list and the whole
     document goes into one localStorage string, so an unbounded history would
     let a single holding crowd out the ledger. */
  var HISTORY_MAX = 400;

  /* Error keys are i18n keys, not sentences: the view decides the wording. */
  var ERR = {
    readOnly: "data.error.readOnly",
    quota: "data.error.quota",
    write: "data.error.write",
    corrupt: "data.error.corrupt",
    newerSchema: "data.error.newerSchema",
    unknownSchema: "data.error.unknownSchema",
    noState: "data.error.notBooted",
    badFile: "data.import.badFile"
  };

  /* --------------------------------------------------------------- helpers */

  /* Core is loaded first in index.html, but store.js stays usable without it
     (node self-test, a stripped page) by falling back to local equivalents. */
  var util = Moon.util || {};

  function clone(value) {
    if (util.clone) return util.clone(value);
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function newId(prefix) {
    if (util.id) return util.id(prefix);
    return prefix + "_" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function lower(value) {
    if (util.lower) return util.lower(value);
    return String(value === null || value === undefined ? "" : value).toLowerCase();
  }

  function debounce(fn, ms) {
    if (util.debounce) return util.debounce(fn, ms);
    var timer = null;
    var wrapped = function () {
      if (timer) global.clearTimeout(timer);
      timer = global.setTimeout(function () {
        timer = null;
        fn();
      }, ms);
    };
    wrapped.cancel = function () {
      if (timer) global.clearTimeout(timer);
      timer = null;
    };
    wrapped.flush = function () {
      if (timer) {
        global.clearTimeout(timer);
        timer = null;
        fn();
      }
    };
    return wrapped;
  }

  function emit(event, payload) {
    if (Moon.bus && Moon.bus.emit) Moon.bus.emit(event, payload);
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function isInt(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
  }

  function str(value) {
    return typeof value === "string" && value !== "" ? value : null;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /* Local civil date. Never toISOString: that reads UTC and shifts the day. */
  function today() {
    if (Moon.Dates && typeof Moon.Dates.today === "function") {
      var fromDates = Moon.Dates.today();
      if (isCivil(fromDates)) return fromDates;
    }
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function isCivil(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var y = parseInt(value.slice(0, 4), 10);
    var m = parseInt(value.slice(5, 7), 10);
    var d = parseInt(value.slice(8, 10), 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    /* Local constructor only, and round-trip to reject 2026-02-31. */
    var probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  }

  function civil(value, fallback) {
    if (isCivil(value)) return value;
    /* Tolerate a stored timestamp from another version: take its date half. */
    if (typeof value === "string" && value.length > 10 && isCivil(value.slice(0, 10))) {
      return value.slice(0, 10);
    }
    return fallback === undefined ? null : fallback;
  }

  function isPeriodKey(value) {
    return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  }

  function stamp() {
    return new Date().toISOString();
  }

  /* Stored money is an integer minor unit. A float or a digit string from
     another version is accepted and squared up; anything else is refused. */
  function toMinor(value) {
    if (typeof value === "number" && isFinite(value)) return Math.round(value);
    if (typeof value === "string" && /^[+-]?\d+$/.test(value)) return parseInt(value, 10);
    return null;
  }

  function copyRecord(record) {
    var out = {};
    Object.keys(record).forEach(function (key) {
      out[key] = record[key];
    });
    return out;
  }

  function nameKey(name) {
    return lower(String(name === null || name === undefined ? "" : name).replace(/\s+/g, " ").trim());
  }

  /* -------------------------------------------------------------- language */

  /* Seed category names are written as plain text in the language active at
     install time; §6.1 says they must not follow later language switches. */
  function activeLang() {
    var picked = Moon.I18n && Moon.I18n.lang;
    if (picked === "tr" || picked === "en") return picked;
    try {
      var nav = global.navigator;
      var tag = nav && (nav.language || (nav.languages && nav.languages[0]));
      if (typeof tag === "string" && tag) {
        return lower(tag).indexOf("tr") === 0 ? "tr" : "en";
      }
    } catch (e) { /* no navigator: fall through */ }
    return "tr";
  }

  function translate(key, lang) {
    var catalog = Moon.Lang && Moon.Lang[lang];
    if (catalog && typeof catalog[key] === "string" && catalog[key] !== "") return catalog[key];
    if (Moon.I18n && typeof Moon.I18n.t === "function") {
      var text = Moon.I18n.t(key);
      if (typeof text === "string" && text !== "") return text;
    }
    return key;
  }

  /* --------------------------------------------------------------- backends */

  function localBackend(ls) {
    return {
      kind: "local",
      get: function (key) {
        try {
          return ls.getItem(key);
        } catch (e) {
          return null;
        }
      },
      /* Deliberately unguarded: the caller must see QuotaExceededError. */
      set: function (key, value) {
        ls.setItem(key, value);
      },
      remove: function (key) {
        try {
          ls.removeItem(key);
        } catch (e) { /* nothing to do */ }
      },
      keys: function () {
        var out = [];
        try {
          for (var i = 0; i < ls.length; i += 1) out.push(ls.key(i));
        } catch (e) { /* partial list is fine */ }
        return out;
      }
    };
  }

  function memoryBackend(seed) {
    var map = {};
    if (seed) {
      Object.keys(seed).forEach(function (key) {
        if (typeof seed[key] === "string") map[key] = seed[key];
      });
    }
    return {
      kind: "memory",
      get: function (key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      set: function (key, value) {
        map[key] = String(value);
      },
      remove: function (key) {
        delete map[key];
      },
      keys: function () {
        return Object.keys(map);
      }
    };
  }

  /* ------------------------------------------------------------- defaults */

  /* Ten colours in one luminance band, so a list of them reads as a set rather
     than as a pile of stickers. The stylesheet exposes the same ten as
     --cat-1 … --cat-10; a record stores the hex itself because the colour
     travels in an export and has to mean the same thing in the next version. */
  var CATEGORY_SPECTRUM = [
    "#8AA6FF", "#3DD6A0", "#FF6F91", "#FFB454", "#B388FF",
    "#45C8E8", "#9BDE4F", "#FF8A5B", "#FF6FD8", "#7E8CB0"
  ];

  /* What a record gets when it arrives with no icon of its own. A bullet is the
     last resort: an empty icon would collapse the row's first column and shift
     every name in the list by a few pixels. */
  var FALLBACK_ICON = "•";
  var ICON_BY_KIND = { income: "💰", expense: "🧾" };
  var ICON_BY_ACCOUNT_KIND = { cash: "👛", bank: "🏦", card: "💳", savings: "🐖" };
  var ICON_BY_INVESTMENT_KIND = {
    stock: "📈",
    fund: "📊",
    crypto: "🪙",
    gold: "🥇",
    fx: "💱",
    property: "🏠",
    other: "📦"
  };

  var ACCOUNT_KINDS = ["cash", "bank", "card", "savings"];
  var INVESTMENT_KINDS = ["stock", "fund", "crypto", "gold", "fx", "property", "other"];

  function lookupOf(list) {
    var map = {};
    list.forEach(function (name) {
      map[name] = 1;
    });
    return map;
  }

  var ACCOUNT_KIND_SET = lookupOf(ACCOUNT_KINDS);
  var INVESTMENT_KIND_SET = lookupOf(INVESTMENT_KINDS);

  /* Colours are dealt down this list in order, so a fresh install and a
     migrated one look the same; the icons are chosen per category because a
     reader recognises their own spending by its picture faster than by its
     name, and only the migration has to fall back to ICON_BY_KIND. */
  var SEED_CATEGORIES = [
    { key: "cat.rent", kind: "expense", fixed: true, color: CATEGORY_SPECTRUM[0], icon: "🏠" },
    { key: "cat.bills", kind: "expense", fixed: true, color: CATEGORY_SPECTRUM[1], icon: "💡" },
    { key: "cat.subscriptions", kind: "expense", fixed: true, color: CATEGORY_SPECTRUM[2], icon: "🔁" },
    { key: "cat.groceries", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[3], icon: "🛒" },
    { key: "cat.eatingOut", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[4], icon: "🍔" },
    { key: "cat.transport", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[5], icon: "🚌" },
    { key: "cat.health", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[6], icon: "🩺" },
    { key: "cat.home", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[7], icon: "🪴" },
    { key: "cat.clothing", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[8], icon: "👕" },
    { key: "cat.fun", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[9], icon: "🎬" },
    { key: "cat.other", kind: "expense", fixed: false, color: CATEGORY_SPECTRUM[0], icon: "🧾" },
    { key: "cat.salary", kind: "income", fixed: false, color: CATEGORY_SPECTRUM[1], icon: "💰" },
    { key: "cat.otherIncome", kind: "income", fixed: false, color: CATEGORY_SPECTRUM[2], icon: "📥" }
  ];

  /* "prism" is the third surface. A theme this list does not know is quietly
     downgraded to "system" on read, so leaving it out would lose the reader's
     choice every time they came back. */
  var THEMES = { system: 1, dial: 1, paper: 1, prism: 1 };
  var CURRENCIES = { TRY: 1, USD: 1, EUR: 1, GBP: 1 };
  var SOURCES = { manual: 1, csv: 1, recurring: 1, sample: 1 };

  function defaultSettings(lang) {
    return {
      lang: lang === "en" ? "en" : "tr",
      currency: "TRY",
      theme: "system",
      monthStartDay: 1,
      overflowMark: "pigment",
      sampleOn: false,
      lastBackup: null,
      changesSinceBackup: 0
    };
  }

  function defaultState(lang) {
    var chosen = lang === "en" ? "en" : "tr";
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: today(),
      settings: defaultSettings(chosen),
      categories: SEED_CATEGORIES.map(function (seed) {
        return {
          id: newId("c"),
          name: translate(seed.key, chosen),
          kind: seed.kind,
          fixed: seed.fixed,
          archived: false,
          color: seed.color,
          icon: seed.icon
        };
      }),
      entries: [],
      limits: [],
      recurring: [],
      goals: [],
      debts: [],
      accounts: [],
      investments: []
    };
  }

  /* ------------------------------------------------------------ validation */

  /* Every fill* returns a normalized record, or null when the record has no
     recoverable identity (no date, no amount). Missing optional fields are
     completed; unknown fields are copied through untouched. */

  /* A tone is stored as six hex digits and reaches the page as an inline
     --tone, so a named colour or a shorthand would arrive at CSS unchecked.
     The case is normalized because a colour the reader picked in one session
     has to compare equal to the same swatch in the next one. */
  function toneOf(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    return /^#[0-9A-Fa-f]{6}$/.test(text) ? "#" + text.slice(1).toUpperCase() : null;
  }

  /* A record that arrives with no colour still has to have one, because the
     view may not invent appearance the export does not carry. The id is the
     only stable thing to deal from: a cursor would hand the same record a
     different colour on every import. */
  function toneFor(seed) {
    var text = String(seed === null || seed === undefined ? "" : seed);
    var sum = 0;
    for (var i = 0; i < text.length; i += 1) {
      sum = (sum * 31 + text.charCodeAt(i)) % 100003;
    }
    return CATEGORY_SPECTRUM[sum % CATEGORY_SPECTRUM.length];
  }

  /* An over-long icon is cut to its first code point rather than to ICON_MAX
     code units: half of a surrogate pair renders as a replacement box, which
     looks like a bug in Moon rather than like a long string in the file. */
  function iconOf(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (text === "") return null;
    if (text.length <= ICON_MAX) return text;
    return String.fromCodePoint(text.codePointAt(0));
  }

  /* Display only: no part of Moon converts between currencies, so any ISO-ish
     code is kept as written rather than forced into a list the reader's bank
     may not be in. */
  function currencyOf(value) {
    if (typeof value === "string" && /^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
    return "TRY";
  }

  /* A record that arrives with no name still has to be findable in a list,
     because that name is the reader's cue to go and fix it. translate() hands
     back the key itself when no catalogue knows it, and a raw key on screen
     reads as a broken app, so common.unclassified — which has shipped since
     v1 — stands in until the catalogue carries the specific one. */
  function untitled(key, lang) {
    var text = translate(key, lang);
    return text === key ? translate("common.unclassified", lang) : text;
  }

  /* A quantity or a unit price cannot be negative — a holding of minus two
     shares is a sign error in the file, not a position Moon models — so the
     magnitude is what survives. toMinor also squares up a float or a digit
     string, and that is a change to the file the reader has to be told about,
     hence the report even when a number comes back. */
  function nonNegativeMinor(value, report) {
    var minor = toMinor(value);
    if (minor === null) return null;
    if (minor < 0 || !isInt(value)) report.repaired += 1;
    return Math.abs(minor);
  }

  function fillCategory(record, lang, report) {
    if (!isObject(record)) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("c");
    if (!str(record.name)) {
      out.name = translate("common.unclassified", lang);
      report.repaired += 1;
    } else {
      out.name = record.name;
    }
    out.kind = record.kind === "income" ? "income" : "expense";
    out.fixed = record.fixed === true;
    out.archived = record.archived === true;
    var tone = toneOf(record.color);
    var icon = iconOf(record.icon);
    /* §3.4: both are required after the v2 migration, so a record without them
       was hand-edited or written by something that is not Moon. Filling them in
       is a change to the file, and the report is how the reader hears about it. */
    if (tone === null || icon === null) report.repaired += 1;
    out.color = tone === null ? toneFor(out.id) : tone;
    out.icon = icon === null ? (ICON_BY_KIND[out.kind] || FALLBACK_ICON) : icon;
    return out;
  }

  function fillEntry(record, lang, report) {
    if (!isObject(record)) return null;
    var date = civil(record.date);
    var minor = toMinor(record.amount);
    if (date === null || minor === null || minor === 0) return null;

    var out = copyRecord(record);
    out.id = str(record.id) || newId("e");
    out.date = date;
    /* §2: amount is always positive, the sign lives in `direction`. A negative
       amount from a foreign export is an expense unless the record says "in". */
    out.amount = Math.abs(minor);
    out.direction = record.direction === "in" ? "in" : "out";
    out.categoryId = str(record.categoryId);
    /* §3.2: the account an entry was paid from is extra information, never a
       requirement. Every entry typed before accounts existed reads as null and
       still counts in every total it counted in before. */
    out.accountId = str(record.accountId);
    out.note = typeof record.note === "string" ? record.note.slice(0, NOTE_MAX) : "";
    out.fixed = record.fixed === true;
    out.source = SOURCES[record.source] ? record.source : "manual";
    out.confirmed = record.confirmed !== false;
    out.recurringId = str(record.recurringId);
    out.createdAt = str(record.createdAt) || stamp();
    if (out.amount !== minor || !str(record.id)) report.repaired += 1;
    return out;
  }

  function fillLimit(record, lang, report) {
    if (!isObject(record)) return null;
    var categoryId = str(record.categoryId);
    var minor = toMinor(record.amount);
    if (categoryId === null || minor === null || minor < 0) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("l");
    out.categoryId = categoryId;
    out.amount = minor;
    return out;
  }

  function fillRecurring(record, lang, report) {
    if (!isObject(record)) return null;
    var minor = toMinor(record.amount);
    if (minor === null || minor === 0) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("r");
    out.name = typeof record.name === "string" ? record.name.slice(0, NOTE_MAX) : "";
    out.amount = Math.abs(minor);
    out.direction = record.direction === "in" ? "in" : "out";
    out.categoryId = str(record.categoryId);
    var day = isInt(record.dayOfMonth) ? record.dayOfMonth : 1;
    out.dayOfMonth = day < 1 ? 1 : (day > 31 ? 31 : day);
    out.fixed = record.fixed === true;
    out.startDate = civil(record.startDate, today());
    out.endDate = civil(record.endDate);
    out.active = record.active !== false;
    out.lastGeneratedPeriod = isPeriodKey(record.lastGeneratedPeriod) ? record.lastGeneratedPeriod : null;
    return out;
  }

  function fillContribution(record) {
    if (!isObject(record)) return null;
    var date = civil(record.date);
    var minor = toMinor(record.amount);
    if (date === null || minor === null || minor <= 0) return null;
    var out = copyRecord(record);
    out.date = date;
    out.amount = minor;
    return out;
  }

  function fillGoal(record, lang, report) {
    if (!isObject(record)) return null;
    var target = toMinor(record.targetAmount);
    if (target === null || target <= 0) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("g");
    out.name = typeof record.name === "string" ? record.name.slice(0, NOTE_MAX) : "";
    out.targetAmount = target;

    out.contributions = [];
    if (Array.isArray(record.contributions)) {
      record.contributions.forEach(function (one) {
        var filled = fillContribution(one);
        if (filled) out.contributions.push(filled);
        else report.dropped += 1;
      });
    } else if (record.contributions !== undefined) {
      report.repaired += 1;
    }

    var saved = toMinor(record.savedAmount);
    if (saved === null || saved < 0) {
      /* §2 keeps savedAmount next to the contributions; when it is missing the
         contributions are the honest source. */
      saved = out.contributions.reduce(function (sum, one) {
        return sum + one.amount;
      }, 0);
      report.repaired += 1;
    }
    out.savedAmount = saved;
    out.dueDate = civil(record.dueDate);
    return out;
  }

  function fillDebt(record, lang, report) {
    if (!isObject(record)) return null;
    var minor = toMinor(record.amount);
    if (minor === null || minor === 0) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("d");
    out.person = typeof record.person === "string" ? record.person.slice(0, NOTE_MAX) : "";
    out.amount = Math.abs(minor);
    out.direction = record.direction === "iOwe" ? "iOwe" : "owedToMe";
    out.date = civil(record.date, today());
    out.dueDate = civil(record.dueDate);
    out.settled = record.settled === true;
    out.settledDate = out.settled ? civil(record.settledDate, out.date) : civil(record.settledDate);
    out.note = typeof record.note === "string" ? record.note.slice(0, NOTE_MAX) : "";
    return out;
  }

  /* An account carries no measurement of its own beyond an opening balance, so
     there is nothing in it that can be unreadable enough to justify dropping
     the record: a hand-edited account comes back repaired, with a name the
     reader can recognise and correct. */
  function fillAccount(record, lang, report) {
    if (!isObject(record)) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("a");

    var name = str(record.name);
    if (name === null) {
      out.name = untitled("accounts.untitled", lang);
      report.repaired += 1;
    } else {
      out.name = name.slice(0, ACCOUNT_NAME_MAX);
      if (out.name !== name) report.repaired += 1;
    }

    out.kind = ACCOUNT_KIND_SET[record.kind] ? record.kind : "cash";
    /* A card starts the month owing money, so the sign is kept exactly as
       written; zero is the honest reading of an account that never said. */
    var opening = toMinor(record.opening);
    if (opening === null) {
      if (record.opening !== undefined) report.repaired += 1;
      opening = 0;
    }
    out.opening = opening;
    out.currency = currencyOf(record.currency);

    var tone = toneOf(record.color);
    var icon = iconOf(record.icon);
    if (tone === null || icon === null) report.repaired += 1;
    out.color = tone === null ? toneFor(out.id) : tone;
    out.icon = icon === null ? (ICON_BY_ACCOUNT_KIND[out.kind] || FALLBACK_ICON) : icon;

    out.archived = record.archived === true;
    out.createdAt = civil(record.createdAt, today());
    return out;
  }

  /* One row of a holding's price history. A row without a date or without a
     price says nothing about what the holding was worth, so it is the one part
     of an investment that can be dropped. */
  function fillPricePoint(record, report) {
    if (!isObject(record)) return null;
    var date = civil(record.date);
    if (date === null) return null;
    var price = nonNegativeMinor(record.unitPrice, report);
    if (price === null) return null;
    var out = copyRecord(record);
    out.date = date;
    out.unitPrice = price;
    return out;
  }

  function fillInvestment(record, lang, report) {
    if (!isObject(record)) return null;
    var out = copyRecord(record);
    out.id = str(record.id) || newId("i");

    var name = str(record.name);
    if (name === null) {
      out.name = untitled("investments.untitled", lang);
      report.repaired += 1;
    } else {
      out.name = name.slice(0, INVESTMENT_NAME_MAX);
      if (out.name !== name) report.repaired += 1;
    }

    out.kind = INVESTMENT_KIND_SET[record.kind] ? record.kind : "other";

    /* §3.3: quantity is an integer with four implied decimals, so half a coin
       is 5000 and never 0.5. A fractional quantity in the file is therefore a
       quantity written in the wrong unit, and there is no way to tell whether
       the writer meant 0.5 units or 0.00005 — it is squared up to the nearest
       stored unit and reported, never multiplied by ten thousand on a hunch. */
    var quantity = nonNegativeMinor(record.quantity, report);
    if (quantity === null) {
      quantity = 0;
      report.repaired += 1;
    }
    out.quantity = quantity;

    var unitCost = nonNegativeMinor(record.unitCost, report);
    if (unitCost === null) {
      unitCost = 0;
      report.repaired += 1;
    }
    out.unitCost = unitCost;

    /* History is what the value-over-time chart reads, so it has to arrive in
       the order that chart walks it and hold one price per day. Two rows for
       one date are an edit the writer meant as a replacement, and the row they
       left behind is the later one. */
    var points = [];
    var seenDates = {};
    if (Array.isArray(record.history)) {
      record.history.forEach(function (one) {
        var point = fillPricePoint(one, report);
        if (point === null) {
          report.dropped += 1;
          return;
        }
        if (Object.prototype.hasOwnProperty.call(seenDates, point.date)) {
          points[seenDates[point.date]] = point;
          report.repaired += 1;
          return;
        }
        seenDates[point.date] = points.length;
        points.push(point);
      });
    } else if (record.history !== undefined) {
      report.repaired += 1;
    }
    points.sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
    if (points.length > HISTORY_MAX) {
      /* Trimming costs the reader prices they once typed, so it is counted as
         loss and not as a repair: the caller copies the file aside before the
         trimmed version takes its place. The newest rows are the ones the
         chart and the current value are computed from. */
      report.dropped += points.length - HISTORY_MAX;
      points = points.slice(points.length - HISTORY_MAX);
    }
    out.history = points;
    var newest = points.length > 0 ? points[points.length - 1] : null;

    /* A holding with no readable price is still worth what it cost, and the
       history knows better than the cost does. Neither is a guess: both are
       numbers the reader typed at a date the file records. */
    var price = nonNegativeMinor(record.unitPrice, report);
    if (price === null) {
      price = newest === null ? unitCost : newest.unitPrice;
      report.repaired += 1;
    }
    out.unitPrice = price;

    out.currency = currencyOf(record.currency);
    out.note = typeof record.note === "string" ? record.note.slice(0, NOTE_MAX) : "";

    var tone = toneOf(record.color);
    var icon = iconOf(record.icon);
    if (tone === null || icon === null) report.repaired += 1;
    out.color = tone === null ? toneFor(out.id) : tone;
    out.icon = icon === null ? (ICON_BY_INVESTMENT_KIND[out.kind] || FALLBACK_ICON) : icon;

    out.archived = record.archived === true;
    out.createdAt = civil(record.createdAt, today());
    /* The price is at least as old as the record, so the day the record was
       created is the honest fallback — today would claim the reader checked a
       price they have not looked at in months. */
    var priceDate = civil(record.priceDate);
    if (priceDate === null) {
      if (record.priceDate !== undefined) report.repaired += 1;
      priceDate = newest === null ? out.createdAt : newest.date;
    }
    out.priceDate = priceDate;
    return out;
  }

  /* Field order here is the export order, and the export is read by humans.
     accounts and investments come last because the six collections above them
     are the ones a v1 backup already had, and a reader comparing an old export
     with a new one should find the familiar part unmoved. */
  var COLLECTIONS = [
    { name: "categories", fill: fillCategory },
    { name: "entries", fill: fillEntry },
    { name: "limits", fill: fillLimit },
    { name: "recurring", fill: fillRecurring },
    { name: "goals", fill: fillGoal },
    { name: "debts", fill: fillDebt },
    { name: "accounts", fill: fillAccount },
    { name: "investments", fill: fillInvestment }
  ];

  var TOP_FIELDS = { schemaVersion: 1, createdAt: 1, settings: 1 };
  COLLECTIONS.forEach(function (spec) {
    TOP_FIELDS[spec.name] = 1;
  });

  function fillSettings(input, lang, report) {
    var out = defaultSettings(lang);
    if (!isObject(input)) {
      if (input !== undefined) report.repaired += 1;
      return out;
    }
    /* Unknown settings keys survive: a newer Moon may have written them. */
    Object.keys(input).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = input[key];
    });

    if (input.lang === "tr" || input.lang === "en") out.lang = input.lang;
    if (typeof input.currency === "string" && /^[A-Za-z]{3}$/.test(input.currency)) {
      out.currency = input.currency.toUpperCase();
    }
    if (THEMES[input.theme]) out.theme = input.theme;
    if (isInt(input.monthStartDay)) {
      out.monthStartDay = input.monthStartDay < 1 ? 1 : (input.monthStartDay > 28 ? 28 : input.monthStartDay);
    }
    if (input.overflowMark === "flare" || input.overflowMark === "pigment") {
      out.overflowMark = input.overflowMark;
    }
    out.sampleOn = input.sampleOn === true;
    out.lastBackup = civil(input.lastBackup);
    if (isInt(input.changesSinceBackup) && input.changesSinceBackup >= 0) {
      out.changesSinceBackup = input.changesSinceBackup;
    }
    return out;
  }

  /* Turns anything that parsed as JSON into a state object this version can
     work with. Never throws; reports what it had to repair or drop. */
  function normalize(input, lang) {
    var report = { repaired: 0, dropped: 0, structural: 0 };
    var out = {};

    if (!isObject(input)) {
      return { state: defaultState(lang), report: { repaired: 0, dropped: 0, structural: 0 }, alien: true };
    }

    /* Unknown top-level fields first into the object, so the known ones below
       keep their contract order in the export. */
    var unknown = {};
    Object.keys(input).forEach(function (key) {
      if (!TOP_FIELDS[key]) unknown[key] = input[key];
    });

    out.schemaVersion = isInt(input.schemaVersion) ? input.schemaVersion : SCHEMA_VERSION;
    if (!isInt(input.schemaVersion)) report.repaired += 1;
    out.createdAt = civil(input.createdAt, today());
    out.settings = fillSettings(input.settings, lang, report);

    COLLECTIONS.forEach(function (spec) {
      var raw = input[spec.name];
      var list = [];
      if (Array.isArray(raw)) {
        raw.forEach(function (record) {
          var filled = spec.fill(record, lang, report);
          if (filled) list.push(filled);
          else report.dropped += 1;
        });
      } else if (raw !== undefined) {
        /* The collection is there but is not a list — an id-keyed map, a string,
           something a hand-edited backup or another tool wrote. Every record in
           it is unreadable, so this counts as loss, not as a repair: the caller
           must copy the bytes aside and say so, rather than overwrite them with
           an empty list and call the file mended. */
        report.repaired += 1;
        report.structural += 1;
      }
      out[spec.name] = list;
    });

    Object.keys(unknown).forEach(function (key) {
      out[key] = unknown[key];
    });

    return { state: out, report: report, alien: false };
  }

  /* A blob that parsed but looks nothing like Moon data must not silently
     replace the user's install; it is treated as corrupt instead. */
  function looksLikeMoon(value) {
    if (!isObject(value)) return false;
    if (isObject(value.settings)) return true;
    for (var i = 0; i < COLLECTIONS.length; i += 1) {
      if (Array.isArray(value[COLLECTIONS[i].name])) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ migrations */

  /* MIGRATIONS[n] carries data from schemaVersion n to n+1. Each step edits the
     blob in place on purpose: a record rebuilt field by field would lose
     whatever a newer Moon wrote into it, and this file promises those fields
     survive a round trip. Every step must also be safe to run twice — the same
     bytes can reach a second tab, or a second device over a synced folder, and
     be migrated again there. */
  var MIGRATIONS = {
    /* v2 adds the two collections the net-worth card sums, and dresses every
       category in the colour and icon the redesigned lists draw. A collection
       that is present but is not a list is left exactly as it is: normalize
       counts that as loss and the caller copies the bytes aside, which is the
       opposite of what replacing it with an empty list would do. */
    1: function (data) {
      if (data.accounts === undefined) data.accounts = [];
      if (data.investments === undefined) data.investments = [];
      if (Array.isArray(data.categories)) {
        data.categories.forEach(function (category, index) {
          if (!isObject(category)) return;
          /* Dealt by position, so the first ten categories are ten different
             colours and the eleventh starts the spectrum again. A category
             that already carries a colour keeps the one it was given. */
          if (toneOf(category.color) === null) {
            category.color = CATEGORY_SPECTRUM[index % CATEGORY_SPECTRUM.length];
          }
          if (iconOf(category.icon) === null) {
            category.icon = ICON_BY_KIND[category.kind] || FALLBACK_ICON;
          }
        });
      }
      data.schemaVersion = 2;
      return data;
    }
  };

  function migrate(data) {
    var working = data;
    var guard = 0;
    while (isInt(working.schemaVersion) && working.schemaVersion < SCHEMA_VERSION) {
      var step = MIGRATIONS[working.schemaVersion];
      if (typeof step !== "function") return { ok: false, data: working };
      working = step(working) || working;
      guard += 1;
      if (guard > 64) return { ok: false, data: working };
    }
    return { ok: true, data: working };
  }

  /* ------------------------------------------------------------ module state */

  var state = null;
  var wipeStamp = null;
  var backend = memoryBackend();
  var testStorage = null;
  var unloadBound = false;
  var idleHandle = null;

  var session = {
    backupTaken: false,
    quarantined: []
  };

  var status = {
    readOnly: false,
    quotaHit: false,
    lastError: null
  };

  function setError(kind, key, error) {
    status.lastError = { kind: kind, messageKey: key, error: error || null };
    return status.lastError;
  }

  function fail(kind, key, error) {
    setError(kind, key, error);
    emit("store:error", { kind: kind, messageKey: key, error: error || null });
  }

  function isQuotaError(error) {
    if (!error) return false;
    return error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22 ||
      error.code === 1014;
  }

  /* ----------------------------------------------------------- persistence */

  function serialize(source, extra) {
    var out = {};
    out.schemaVersion = source.schemaVersion;
    out.createdAt = source.createdAt;
    out.settings = source.settings;
    COLLECTIONS.forEach(function (spec) {
      out[spec.name] = source[spec.name];
    });
    Object.keys(source).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = source[key];
    });
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        out[key] = extra[key];
      });
    }
    return out;
  }

  /* One snapshot per session, taken right before the first write of that
     session. Backing up on every write would double the storage bill. */
  function takeSessionBackup(force) {
    if (session.backupTaken && !force) return;
    session.backupTaken = true;
    var previous = backend.get(KEY);
    if (previous === null || previous === "") return;
    try {
      backend.set(BACKUP_KEY, previous);
    } catch (e) {
      /* A backup that does not fit must never block the real write. */
    }
  }

  /* Copies unreadable data aside instead of dropping it. Returns false when
     even the copy fails — the caller then refuses to write over the original. */
  function quarantine(text) {
    if (typeof text !== "string" || text === "") return true;
    var key = CORRUPT_PREFIX + Date.now();
    var suffix = 0;
    while (backend.get(key) !== null && suffix < 50) {
      suffix += 1;
      key = CORRUPT_PREFIX + Date.now() + "." + suffix;
    }
    try {
      backend.set(key, text);
      session.quarantined.push(key);
      backend.remove(KEY);
      return true;
    } catch (e) {
      setError("corrupt", ERR.corrupt, e);
      return false;
    }
  }

  function cancelIdle() {
    if (idleHandle !== null && typeof global.cancelIdleCallback === "function") {
      try {
        global.cancelIdleCallback(idleHandle);
      } catch (e) { /* already ran */ }
    }
    idleHandle = null;
  }

  function persistNow() {
    writeSoon.cancel();
    cancelIdle();

    if (!state) return { ok: false, error: ERR.noState };
    if (status.readOnly) return { ok: false, error: ERR.readOnly };

    var text;
    try {
      text = JSON.stringify(serialize(state));
    } catch (e) {
      fail("write", ERR.write, e);
      return { ok: false, error: ERR.write };
    }

    takeSessionBackup(false);

    try {
      backend.set(KEY, text);
      status.quotaHit = false;
      status.lastError = null;
      return { ok: true };
    } catch (e) {
      /* The in-memory change stays. The user sees their entry and a warning. */
      if (isQuotaError(e)) {
        status.quotaHit = true;
        fail("quota", ERR.quota, e);
        return { ok: false, error: ERR.quota };
      }
      fail("write", ERR.write, e);
      return { ok: false, error: ERR.write };
    }
  }

  /* Debounced so a form typed into once writes once; idle so the write never
     competes with a render. */
  var writeSoon = debounce(function () {
    if (typeof global.requestIdleCallback === "function") {
      idleHandle = global.requestIdleCallback(function () {
        idleHandle = null;
        persistNow();
      }, { timeout: 1000 });
      return;
    }
    persistNow();
  }, WRITE_DELAY);

  function flushPending() {
    if (idleHandle !== null) {
      cancelIdle();
      persistNow();
      return;
    }
    writeSoon.flush();
  }

  function bindUnload() {
    if (unloadBound || typeof global.addEventListener !== "function") return;
    unloadBound = true;
    /* Closing the tab mid-debounce must not cost the last entry. pagehide
       covers the Safari case where beforeunload does not fire. */
    global.addEventListener("beforeunload", flushPending);
    global.addEventListener("pagehide", flushPending);
    global.addEventListener("storage", adoptForeignWrite);
  }

  /* Two tabs of Moon are ordinary — the panel in one, the ledger in another —
     and each holds its own copy of the document. Without this, whichever tab
     saves last overwrites the other tab's entries with a state that never had
     them, and the backup key gets overwritten on the next save too, so there is
     nowhere left to recover them from. The `storage` event only fires in the
     *other* tabs, so adopting the written document here cannot loop: this tab
     drops its stale copy, takes what is on disk, and redraws. Anything it had
     typed but not yet saved is flushed first, so the merge direction is "both
     writes land", not "newest tab wins". */
  function adoptForeignWrite(event) {
    if (!event || !state) return;

    /* Another tab erased everything. That is an instruction, not a write to be
       merged: drop what this tab holds and follow it. */
    if (event.key === WIPE_KEY) {
      if (!event.newValue || event.newValue === wipeStamp) return;
      wipeStamp = event.newValue;
      cancelIdle();
      writeSoon.cancel();
      var raw = backend.get(KEY);
      var fresh = null;
      if (raw) {
        try {
          fresh = normalize(JSON.parse(raw), activeLang());
        } catch (error) { fresh = null; }
      }
      state = fresh && fresh.state ? fresh.state : defaultState(activeLang());
      emit("state:change", { reason: "storage:wiped" });
      return;
    }

    if (event.key !== KEY) return;
    if (event.newValue === null || event.newValue === undefined) return;

    var adopted;
    try {
      adopted = normalize(JSON.parse(event.newValue), activeLang());
    } catch (error) {
      /* The other tab wrote something unreadable: keep what is in memory here
         rather than throwing this tab's good copy away. */
      return;
    }
    if (!adopted || !adopted.state) return;

    var mine = state;
    var next = adopted.state;
    var rescued = 0;

    /* Records are id-keyed, so the two documents can be unioned: take what the
       other tab wrote and put back anything only this tab has. A record one tab
       deleted while the other still held it comes back — losing a deletion is
       cheaper than losing an entry, and the reader can delete it again. */
    COLLECTIONS.forEach(function (spec) {
      var seen = {};
      if (!Array.isArray(next[spec.name])) next[spec.name] = [];
      next[spec.name].forEach(function (record) {
        if (record && record.id) seen[record.id] = true;
      });
      (Array.isArray(mine[spec.name]) ? mine[spec.name] : []).forEach(function (record) {
        if (!record || !record.id || seen[record.id]) return;
        next[spec.name].push(record);
        rescued += 1;
      });
    });

    /* A write queued here was built on the copy we just replaced; letting it
       land would undo the other tab. The union below takes its place. */
    cancelIdle();
    writeSoon.cancel();

    state = next;
    emit("state:change", { reason: "storage:foreign" });
    if (rescued > 0) persist(true);
  }

  /* ------------------------------------------------------------------ boot */

  function resolveStorage() {
    if (testStorage) return testStorage;
    try {
      return global.localStorage || null;
    } catch (e) {
      /* Accessing the property itself throws when storage is blocked. */
      return null;
    }
  }

  function probeStorage(ls) {
    if (!ls) return { ok: false, error: null };
    try {
      ls.setItem(PROBE_KEY, "1");
      var echo = ls.getItem(PROBE_KEY);
      ls.removeItem(PROBE_KEY);
      if (echo !== "1") return { ok: false, error: null };
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  /* Write access can be gone while read access still works. Copy what is
     there so a read-only session still shows the user their own data. */
  function readSeed(ls) {
    var seed = {};
    if (!ls) return seed;
    [KEY, BACKUP_KEY].forEach(function (key) {
      try {
        var value = ls.getItem(key);
        if (typeof value === "string") seed[key] = value;
      } catch (e) { /* unreadable: nothing to seed */ }
    });
    return seed;
  }

  function parseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function adopt(parsed, lang) {
    var normalized = normalize(parsed, lang);
    state = normalized.state;
    return normalized.report;
  }

  function loadFrom(rawText, lang) {
    var primary = parseJson(rawText);
    var usedBackup = false;
    var parsed = null;

    if (primary.ok && looksLikeMoon(primary.value)) {
      parsed = primary.value;
    } else {
      /* Unreadable primary: try this session's snapshot before giving up. */
      var backupText = backend.get(BACKUP_KEY);
      var fromBackup = backupText ? parseJson(backupText) : { ok: false };
      if (fromBackup.ok && looksLikeMoon(fromBackup.value)) {
        parsed = fromBackup.value;
        usedBackup = true;
      }
    }

    if (!parsed) {
      /* Nothing readable anywhere: move the bytes aside, open clean, say so. */
      var moved = quarantine(rawText);
      state = defaultState(lang);
      if (!moved) status.readOnly = true;
      fail("corrupt", ERR.corrupt, primary.error || null);
      return { reason: "corrupt", quarantined: moved };
    }

    var version = isInt(parsed.schemaVersion) ? parsed.schemaVersion : SCHEMA_VERSION;

    if (version > SCHEMA_VERSION) {
      /* Data from a newer Moon: show it, never write over it. */
      adopt(parsed, lang);
      status.readOnly = true;
      fail("readonly", ERR.newerSchema, null);
      return { reason: "future" };
    }

    var migrated = false;
    if (version < SCHEMA_VERSION) {
      takeSessionBackup(true);
      var result = migrate(clone(parsed));
      if (!result.ok) {
        /* A version we have no path from. Read-only beats a lossy guess. */
        adopt(parsed, lang);
        status.readOnly = true;
        fail("readonly", ERR.unknownSchema, null);
        return { reason: "unknownSchema" };
      }
      parsed = result.data;
      migrated = true;
    }

    var report = adopt(parsed, lang);

    if (usedBackup) {
      /* Keep the damaged primary for inspection, then continue on the backup. */
      var movedPrimary = quarantine(rawText);
      if (!movedPrimary) status.readOnly = true;
      fail("corrupt", ERR.corrupt, primary.error || null);
      persist(migrated);
      return { reason: "backup", repaired: report.repaired, dropped: report.dropped };
    }

    if (report.dropped > 0 || report.structural > 0) {
      /* Records we could not read are copied aside before the repaired state
         overwrites them, so "repair" can never mean "quietly lost". */
      if (!quarantine(rawText)) status.readOnly = true;
      fail("corrupt", ERR.corrupt, null);
      persist(true);
      return { reason: "repaired", repaired: report.repaired, dropped: report.dropped };
    }

    if (migrated || report.repaired > 0) {
      persist(true);
      return { reason: migrated ? "migrated" : "repaired", repaired: report.repaired, dropped: 0 };
    }

    return { reason: "loaded", repaired: 0, dropped: 0 };
  }

  function persist(immediate) {
    if (immediate) persistNow();
    else writeSoon();
  }

  function boot() {
    var ls = resolveStorage();
    var probe = probeStorage(ls);

    session.backupTaken = false;
    session.quarantined = [];
    status.readOnly = !probe.ok;
    status.quotaHit = false;
    status.lastError = null;
    cancelIdle();
    writeSoon.cancel();

    backend = probe.ok ? localBackend(ls) : memoryBackend(readSeed(ls));
    wipeStamp = backend.get(WIPE_KEY) || null;
    bindUnload();

    var lang = activeLang();
    var rawText = backend.get(KEY);
    var outcome;

    if (rawText === null || rawText === undefined || rawText === "") {
      state = defaultState(lang);
      outcome = { reason: "new" };
      /* Write immediately: the pre-paint theme reader in index.html and the
         next session both want a real key, not an empty install. */
      persist(true);
    } else {
      outcome = loadFrom(rawText, lang);
    }

    if (!probe.ok) {
      setError("readonly", ERR.readOnly, probe.error);
      emit("store:error", { kind: "readonly", messageKey: ERR.readOnly, error: probe.error || null });
      if (outcome.reason === "new" || outcome.reason === "loaded") outcome.reason = "readonly";
    }

    return {
      ok: true,
      readOnly: status.readOnly,
      reason: outcome.reason,
      repaired: outcome.repaired || 0,
      dropped: outcome.dropped || 0
    };
  }

  /* ---------------------------------------------------------------- update */

  function ensureShape(draft) {
    if (!isObject(draft.settings)) draft.settings = defaultSettings(activeLang());
    if (!isInt(draft.schemaVersion)) draft.schemaVersion = SCHEMA_VERSION;
    if (!isCivil(draft.createdAt)) draft.createdAt = today();
    COLLECTIONS.forEach(function (spec) {
      if (!Array.isArray(draft[spec.name])) draft[spec.name] = [];
    });
  }

  function update(mutator, opts) {
    opts = opts || {};
    if (typeof mutator !== "function") return state;
    if (!state) boot();

    /* The mutator runs on a deep copy: a mutator that throws halfway leaves
       the live state exactly as it was, never half-changed. */
    var draft = clone(state);
    try {
      mutator(draft);
    } catch (e) {
      setError("write", ERR.write, e);
      if (global.console) global.console.error("Moon.Store.update mutator failed", e);
      return null;
    }

    ensureShape(draft);
    if (opts.countsAsChange !== false) {
      var seen = draft.settings.changesSinceBackup;
      draft.settings.changesSinceBackup = (isInt(seen) && seen >= 0 ? seen : 0) + 1;
    }

    state = draft;
    /* State first, storage later: the UI never waits on a write. */
    emit("state:change", { reason: opts.reason || "update" });
    persist(opts.immediate === true);
    return state;
  }

  /* ---------------------------------------------------------- export/import */

  function exportJson() {
    if (!state) boot();
    return JSON.stringify(serialize(state, { exportedAt: stamp() }), null, 2);
  }

  function exportFilename() {
    return "moon-yedek-" + today() + ".json";
  }

  /* `dropped` and `repaired` come from normalize and are part of every answer,
     zero included: a caller that only prints the rows it got would otherwise
     have no way to learn that the file held more. */
  function emptyCounts() {
    var counts = { skipped: 0, mergedCategories: 0, dropped: 0, repaired: 0 };
    COLLECTIONS.forEach(function (spec) {
      counts[spec.name] = 0;
    });
    return counts;
  }

  function importJson(text, opts) {
    opts = opts || {};
    var mode = opts.mode === "replace" ? "replace" : "merge";
    var counts = emptyCounts();

    if (typeof text !== "string" || text.replace(/^﻿/, "").trim() === "") {
      return { ok: false, error: ERR.badFile, counts: counts };
    }
    var parsed = parseJson(text.replace(/^﻿/, ""));
    if (!parsed.ok || !looksLikeMoon(parsed.value)) {
      return { ok: false, error: ERR.badFile, counts: counts };
    }

    var incomingVersion = isInt(parsed.value.schemaVersion) ? parsed.value.schemaVersion : SCHEMA_VERSION;
    if (incomingVersion > SCHEMA_VERSION) {
      return { ok: false, error: ERR.badFile, reason: "newerSchema", counts: counts };
    }
    var stepped = migrate(clone(parsed.value));
    if (!stepped.ok) {
      return { ok: false, error: ERR.badFile, reason: "unknownSchema", counts: counts };
    }

    var lang = activeLang();
    var normalized = normalize(stepped.data, lang);
    var incoming = normalized.state;
    var report = normalized.report || { repaired: 0, dropped: 0, structural: 0 };

    /* Rows normalize could not read are gone from `incoming`, so counting what
       arrived says nothing about what the file held. Carry the report out: the
       reader has to be told "N records could not be read", especially in
       replace mode, where their own data is on the way out. */
    counts.dropped = (isInt(report.dropped) ? report.dropped : 0) +
      (isInt(report.structural) ? report.structural : 0);
    counts.repaired = isInt(report.repaired) ? report.repaired : 0;

    if (mode === "replace") {
      COLLECTIONS.forEach(function (spec) {
        counts[spec.name] = incoming[spec.name].length;
      });
      /* Replace deletes everything the reader has, and `counts.dropped` above
         says the file that takes its place may hold less. Flush whatever is
         still sitting in the write debounce and force a copy of the whole of
         it under the backup key, so the loss is recoverable instead of final.
         Forced, because persistNow's own snapshot is once per session and may
         already have been spent on an older state. */
      persistNow();
      takeSessionBackup(true);
      var written = update(function (draft) {
        Object.keys(draft).forEach(function (key) {
          delete draft[key];
        });
        Object.keys(incoming).forEach(function (key) {
          draft[key] = incoming[key];
        });
        draft.settings.changesSinceBackup = 0;
      }, { reason: "data:import", immediate: true, countsAsChange: false });
      if (!written) return { ok: false, error: ERR.write, counts: emptyCounts() };
      return { ok: true, error: null, mode: mode, counts: counts };
    }

    /* merge: existing records win. Same-name categories fold into the one that
       is already there, so an import never grows a second "Market". */
    var byName = {};
    var existingIds = {};
    COLLECTIONS.forEach(function (spec) {
      existingIds[spec.name] = {};
      state[spec.name].forEach(function (record) {
        existingIds[spec.name][record.id] = true;
      });
    });
    state.categories.forEach(function (category) {
      byName[nameKey(category.name)] = category.id;
    });

    var remap = {};
    /* Built from COLLECTIONS rather than written out, so a collection added to
       the schema cannot reach this path without a list to be pushed into. */
    var additions = {};
    COLLECTIONS.forEach(function (spec) {
      additions[spec.name] = [];
    });

    incoming.categories.forEach(function (category) {
      var twin = byName[nameKey(category.name)];
      if (twin) {
        if (twin !== category.id) remap[category.id] = twin;
        counts.mergedCategories += 1;
        return;
      }
      if (existingIds.categories[category.id]) {
        counts.skipped += 1;
        return;
      }
      byName[nameKey(category.name)] = category.id;
      existingIds.categories[category.id] = true;
      additions.categories.push(category);
    });

    function withRemap(record) {
      if (record.categoryId && remap[record.categoryId]) {
        record.categoryId = remap[record.categoryId];
      }
      return record;
    }

    /* A limit is identified by its category, not by its id: two installations
       describe the same budget with two different ids. Letting both in gives one
       category two limit rows, and the two readers of that list disagree —
       periodSummary adds them up (so the daily allowance hands out money twice)
       while budgetRows shows one of them. The reader's own limit wins; the
       incoming duplicate is skipped and counted. */
    var limitedCategories = {};
    (state && Array.isArray(state.limits) ? state.limits : []).forEach(function (limit) {
      if (limit && limit.categoryId) limitedCategories[limit.categoryId] = true;
    });

    /* Categories are already in: they fold by name above, and everything else
       has to be remapped onto the ids that fold produced. */
    COLLECTIONS.forEach(function (spec) {
      var name = spec.name;
      if (name === "categories") return;
      incoming[name].forEach(function (record) {
        if (existingIds[name][record.id]) {
          counts.skipped += 1;
          return;
        }
        var ready = withRemap(record);
        if (name === "limits") {
          if (!ready.categoryId || limitedCategories[ready.categoryId]) {
            counts.skipped += 1;
            return;
          }
          limitedCategories[ready.categoryId] = true;
        }
        existingIds[name][record.id] = true;
        additions[name].push(ready);
      });
    });

    COLLECTIONS.forEach(function (spec) {
      counts[spec.name] = additions[spec.name].length;
    });

    var merged = update(function (draft) {
      COLLECTIONS.forEach(function (spec) {
        additions[spec.name].forEach(function (record) {
          draft[spec.name].push(record);
        });
      });
    }, { reason: "data:import", immediate: true });
    if (!merged) return { ok: false, error: ERR.write, counts: emptyCounts() };

    return { ok: true, error: null, mode: mode, counts: counts };
  }

  function wipe() {
    var previous = state && state.settings ? state.settings : null;
    writeSoon.cancel();
    cancelIdle();

    backend.remove(KEY);
    backend.remove(BACKUP_KEY);
    backend.remove(PROBE_KEY);

    /* "Erase everything" has to include the block quarantine() set aside, or a
       reader who arrived through a corrupt boot still carries it: usage() keeps
       counting those bytes, so the one way out of a full quota frees nothing,
       and no section of the app can show or remove them. */
    backend.keys().forEach(function (key) {
      if (typeof key === "string" && key.indexOf(CORRUPT_PREFIX) === 0) backend.remove(key);
    });
    session.quarantined = [];
    session.backupTaken = true;

    /* Another tab still holds the records in memory, and the union in
       adoptForeignWrite would hand them back on its next save — "erase
       everything" would quietly undo itself. This stamp travels as its own key
       so the schema stays as the contract describes it; a tab that sees it
       newer than the one it booted with drops what it holds instead of
       rescuing it. */
    wipeStamp = String(Date.now());
    try {
      backend.set(WIPE_KEY, wipeStamp);
    } catch (error) { /* read-only session: the wipe is local to this tab */ }

    var lang = previous && previous.lang === "en" ? "en" : (previous && previous.lang === "tr" ? "tr" : activeLang());
    state = defaultState(lang);
    /* Data goes, preferences stay: resetting the reader's language and theme
       mid-session would be a second surprise on top of the one they asked for. */
    if (previous) {
      state.settings.currency = previous.currency || state.settings.currency;
      state.settings.theme = THEMES[previous.theme] ? previous.theme : state.settings.theme;
      state.settings.monthStartDay = isInt(previous.monthStartDay) ? previous.monthStartDay : 1;
      state.settings.overflowMark = previous.overflowMark === "flare" ? "flare" : "pigment";
    }
    status.quotaHit = false;
    status.lastError = null;

    persist(true);
    emit("state:change", { reason: "data:wipe" });
  }

  /* The blocks quarantine() set aside, newest key last. data.error.corrupt
     promises the reader their unreadable data was kept rather than deleted;
     without a way to list and read it that promise is empty, so the Data
     section can offer the raw text as a download. */
  function quarantinedBlocks() {
    return backend.keys().filter(function (key) {
      return typeof key === "string" && key.indexOf(CORRUPT_PREFIX) === 0;
    }).sort().map(function (key) {
      var value = backend.get(key);
      return { key: key, bytes: typeof value === "string" ? value.length : 0 };
    });
  }

  /* The raw bytes of one quarantined block, or null. Never parsed: the point of
     the copy is that it could not be read. */
  function readQuarantined(key) {
    if (typeof key !== "string" || key.indexOf(CORRUPT_PREFIX) !== 0) return null;
    var value = backend.get(key);
    return typeof value === "string" ? value : null;
  }

  function dropQuarantined(key) {
    if (typeof key !== "string" || key.indexOf(CORRUPT_PREFIX) !== 0) return false;
    if (backend.get(key) === null) return false;
    backend.remove(key);
    session.quarantined = session.quarantined.filter(function (held) {
      return held !== key;
    });
    return true;
  }

  /* Rough storage footprint for the Data section's usage meter. */
  function usage() {
    var bytes = 0;
    var keys = backend.keys().filter(function (key) {
      return key === KEY || key === BACKUP_KEY || key.indexOf(CORRUPT_PREFIX) === 0;
    });
    keys.forEach(function (key) {
      var value = backend.get(key);
      if (typeof value === "string") bytes += value.length + key.length;
    });
    return { bytes: bytes, keys: keys, backend: backend.kind };
  }

  /* ------------------------------------------------------------------ api */

  var Store = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    PROBE_KEY: PROBE_KEY,
    CORRUPT_PREFIX: CORRUPT_PREFIX,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MIGRATIONS: MIGRATIONS,
    /* The shape constants travel with the store because the store is what
       enforces them: a category editor offering an eleventh colour, or a model
       validator allowing a 90-character account name, would be writing records
       this file then quietly repairs. */
    CATEGORY_SPECTRUM: CATEGORY_SPECTRUM,
    ICON_BY_KIND: ICON_BY_KIND,
    ICON_BY_ACCOUNT_KIND: ICON_BY_ACCOUNT_KIND,
    ICON_BY_INVESTMENT_KIND: ICON_BY_INVESTMENT_KIND,
    FALLBACK_ICON: FALLBACK_ICON,
    ACCOUNT_KINDS: ACCOUNT_KINDS,
    INVESTMENT_KINDS: INVESTMENT_KINDS,
    ACCOUNT_NAME_MAX: ACCOUNT_NAME_MAX,
    INVESTMENT_NAME_MAX: INVESTMENT_NAME_MAX,
    NOTE_MAX: NOTE_MAX,
    ICON_MAX: ICON_MAX,
    HISTORY_MAX: HISTORY_MAX,
    status: status,

    boot: boot,
    update: update,
    persistNow: persistNow,
    exportJson: exportJson,
    exportFilename: exportFilename,
    importJson: importJson,
    wipe: wipe,
    usage: usage,
    quarantinedBlocks: quarantinedBlocks,
    readQuarantined: readQuarantined,
    dropQuarantined: dropQuarantined
  };

  /* A getter, not a field: the state object is replaced on every update and a
     stale copy in a view would be worse than a slow one. */
  Object.defineProperty(Store, "state", {
    enumerable: true,
    get: function () {
      return state;
    }
  });

  Moon.Store = Store;

  /* ------------------------------------------------------------- self-test */

  /* Runs the whole boot/update/export/import/wipe path plus the failure paths
     against an in-memory storage shim. Leaves the live session as it found it. */
  Store._selftest = function () {
    var results = [];

    function assert(condition, message) {
      if (!condition) throw new Error(message || "assertion failed");
    }

    function check(name, fn) {
      try {
        fn();
        results.push({ name: name, ok: true, detail: null });
      } catch (e) {
        results.push({ name: name, ok: false, detail: e && e.message ? e.message : String(e) });
      }
    }

    function makeShim(seed) {
      var map = {};
      if (seed) {
        Object.keys(seed).forEach(function (key) {
          map[key] = String(seed[key]);
        });
      }
      var shim = {
        failAlways: false,
        failNext: 0,
        get length() {
          return Object.keys(map).length;
        },
        key: function (i) {
          var keys = Object.keys(map);
          return i < keys.length ? keys[i] : null;
        },
        getItem: function (key) {
          return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
        },
        setItem: function (key, value) {
          if (shim.failAlways || shim.failNext > 0) {
            if (shim.failNext > 0) shim.failNext -= 1;
            var error = new Error("quota");
            error.name = "QuotaExceededError";
            error.code = 22;
            throw error;
          }
          map[key] = String(value);
        },
        removeItem: function (key) {
          delete map[key];
        },
        raw: map
      };
      return shim;
    }

    function listen() {
      var seen = [];
      var offs = [];
      if (Moon.bus && Moon.bus.on) {
        ["store:error", "state:change"].forEach(function (event) {
          offs.push(Moon.bus.on(event, function (payload) {
            seen.push({ event: event, payload: payload || {} });
          }));
        });
      }
      return {
        seen: seen,
        kinds: function () {
          return seen.filter(function (one) {
            return one.event === "store:error";
          }).map(function (one) {
            return one.payload.kind;
          });
        },
        stop: function () {
          offs.forEach(function (off) {
            off();
          });
        }
      };
    }

    function stored(shim) {
      var text = shim.getItem(KEY);
      return text ? JSON.parse(text) : null;
    }

    var savedState = state;
    var savedBackend = backend;
    var savedStatus = { readOnly: status.readOnly, quotaHit: status.quotaHit, lastError: status.lastError };
    var savedSession = { backupTaken: session.backupTaken, quarantined: session.quarantined };
    writeSoon.cancel();
    cancelIdle();

    try {
      /* 1 — fresh install */
      check("boot: fresh install seeds settings and 13 categories", function () {
        testStorage = makeShim();
        var out = boot();
        assert(out.ok && out.readOnly === false, "boot should succeed writable");
        assert(out.reason === "new", "reason should be new, got " + out.reason);
        assert(state.categories.length === 13, "expected 13 categories, got " + state.categories.length);
        var fixed = state.categories.filter(function (c) {
          return c.fixed;
        });
        assert(fixed.length === 3, "expected 3 fixed categories, got " + fixed.length);
        var income = state.categories.filter(function (c) {
          return c.kind === "income";
        });
        assert(income.length === 2, "expected 2 income categories");
        assert(state.settings.monthStartDay === 1 && state.settings.overflowMark === "pigment", "settings defaults");
        assert(/^\d{4}-\d{2}-\d{2}$/.test(state.createdAt), "createdAt must be a civil date");
        var dressed = state.categories.filter(function (c) {
          return typeof c.color === "string" && c.color !== "" && typeof c.icon === "string" && c.icon !== "";
        });
        assert(dressed.length === 13, "every seed category needs a colour and an icon, got " + dressed.length);
        assert(state.schemaVersion === SCHEMA_VERSION, "a fresh install is written at the current version");
        assert(Array.isArray(state.accounts) && Array.isArray(state.investments), "both v2 collections exist");
        assert(stored(testStorage) !== null, "fresh install must be persisted");
      });

      /* 2 — update: memory first, storage on debounce */
      check("update: state:change is immediate, the write is deferred", function () {
        testStorage = makeShim();
        boot();
        var tap = listen();
        var catId = state.categories[0].id;
        update(function (draft) {
          draft.entries.push({
            id: "e_test1", date: "2026-09-26", amount: 24890, direction: "out",
            categoryId: catId, note: "A101", fixed: false, source: "manual",
            confirmed: true, recurringId: null, createdAt: stamp()
          });
        }, { reason: "entry:add" });
        tap.stop();
        assert(state.entries.length === 1, "entry should be in memory");
        assert(state.settings.changesSinceBackup === 1, "changesSinceBackup should be 1");
        var changes = tap.seen.filter(function (one) {
          return one.event === "state:change";
        });
        assert(changes.length === 1 && changes[0].payload.reason === "entry:add", "state:change reason");
        assert(stored(testStorage).entries.length === 0, "write must still be pending");
        var flushed = persistNow();
        assert(flushed.ok, "persistNow should succeed");
        assert(stored(testStorage).entries.length === 1, "entry should be on disk after flush");
      });

      /* 3 — reboot reads it back */
      check("boot: existing data loads unchanged", function () {
        var shim = testStorage;
        var before = JSON.stringify(stored(shim));
        var out = boot();
        assert(out.reason === "loaded", "reason should be loaded, got " + out.reason);
        assert(state.entries.length === 1 && state.entries[0].amount === 24890, "entry should survive");
        assert(out.repaired === 0 && out.dropped === 0, "clean data needs no repair");
        assert(JSON.stringify(stored(shim)) === before, "a clean load must not rewrite");
      });

      /* 4 — schema repair keeps unknown fields, drops only the unreadable */
      check("boot: repairs shape, keeps unknown fields, quarantines the loss", function () {
        testStorage = makeShim({
          "moon.v1": JSON.stringify({
            schemaVersion: 1,
            categories: "not-an-array",
            entries: [
              { id: "e_bad", date: "nope", amount: 100 },
              { id: "e_ok", date: "2026-09-01", amount: "1234", direction: "in", futureField: "keep me" },
              { id: "e_neg", date: "2026-09-02", amount: -5000 }
            ],
            goals: [{ id: "g_1", name: "Trip", targetAmount: 100000, contributions: [{ date: "2026-09-01", amount: 2500 }] }]
          })
        });
        var tap = listen();
        var out = boot();
        tap.stop();
        assert(Array.isArray(state.categories), "categories must become an array");
        assert(state.entries.length === 2, "one unreadable entry should drop, got " + state.entries.length);
        var kept = state.entries[0];
        assert(kept.amount === 1234 && kept.direction === "in", "digit string amount should parse");
        assert(kept.futureField === "keep me", "unknown field must survive");
        assert(kept.confirmed === true && kept.source === "manual", "missing fields filled with defaults");
        assert(state.entries[1].amount === 5000 && state.entries[1].direction === "out", "negative amount becomes out");
        assert(state.goals[0].savedAmount === 2500, "savedAmount derived from contributions");
        assert(out.dropped === 1, "dropped count should be reported");
        assert(tap.kinds().indexOf("corrupt") !== -1, "dropping data must warn");
        var quarantineKeys = Object.keys(testStorage.raw).filter(function (key) {
          return key.indexOf(CORRUPT_PREFIX) === 0;
        });
        assert(quarantineKeys.length === 1, "original bytes must be kept aside");
        assert(JSON.parse(testStorage.raw[quarantineKeys[0]]).entries.length === 3, "quarantine holds all 3 rows");
      });

      /* 5 — unreadable JSON, no backup */
      check("boot: corrupt JSON is moved aside, not deleted", function () {
        testStorage = makeShim({ "moon.v1": "{not json" });
        var tap = listen();
        var out = boot();
        tap.stop();
        assert(out.reason === "corrupt", "reason should be corrupt, got " + out.reason);
        assert(state.categories.length === 13, "should open on defaults");
        assert(tap.kinds().indexOf("corrupt") !== -1, "store:error kind corrupt expected");
        var keys = Object.keys(testStorage.raw).filter(function (key) {
          return key.indexOf(CORRUPT_PREFIX) === 0;
        });
        assert(keys.length === 1, "corrupt copy expected");
        assert(testStorage.raw[keys[0]] === "{not json", "corrupt bytes must be byte-identical");
      });

      /* 6 — unreadable JSON with a usable backup */
      check("boot: falls back to moon.v1.bak when the primary is broken", function () {
        testStorage = makeShim({
          "moon.v1": "{half written",
          "moon.v1.bak": JSON.stringify({
            schemaVersion: 1, createdAt: "2026-09-01",
            settings: { lang: "en", currency: "USD" },
            categories: [{ id: "c_1", name: "Rent", kind: "expense", fixed: true }],
            entries: [{ id: "e_1", date: "2026-09-10", amount: 999, direction: "out" }]
          })
        });
        var tap = listen();
        var out = boot();
        tap.stop();
        assert(out.reason === "backup", "reason should be backup, got " + out.reason);
        assert(state.entries.length === 1 && state.entries[0].amount === 999, "backup data restored");
        assert(state.settings.lang === "en" && state.settings.currency === "USD", "backup settings restored");
        assert(tap.kinds().indexOf("corrupt") !== -1, "the broken primary must be reported");
      });

      /* 7 — data from a newer Moon */
      check("boot: newer schemaVersion opens read-only and writes nothing", function () {
        var future = JSON.stringify({
          schemaVersion: 99, createdAt: "2026-09-01", settings: { lang: "tr" },
          categories: [], entries: [{ id: "e_f", date: "2026-09-05", amount: 1500, direction: "out" }]
        });
        testStorage = makeShim({ "moon.v1": future });
        var tap = listen();
        var out = boot();
        assert(out.readOnly === true && out.reason === "future", "should be read-only future");
        assert(state.entries.length === 1, "future data must still be visible");
        update(function (draft) {
          draft.entries.push({ id: "e_x", date: "2026-09-06", amount: 100, direction: "out" });
        }, { immediate: true });
        tap.stop();
        assert(state.entries.length === 2, "the session may still work in memory");
        assert(testStorage.raw["moon.v1"] === future, "stored bytes must be untouched");
        assert(persistNow().error === ERR.readOnly, "persistNow must refuse");
        assert(tap.kinds().indexOf("readonly") !== -1, "readonly warning expected");
      });

      /* 8 — schemaVersion we have no migration for */
      check("boot: unknown older schemaVersion opens read-only", function () {
        testStorage = makeShim({
          "moon.v1": JSON.stringify({ schemaVersion: 0, settings: {}, entries: [], categories: [] })
        });
        var out = boot();
        assert(out.readOnly === true && out.reason === "unknownSchema", "reason: " + out.reason);
        assert(status.lastError && status.lastError.messageKey === ERR.unknownSchema, "lastError key");
      });

      /* 8b — the v1 → v2 step on its own: dealt colours, both new collections,
               nothing of the reader's lost, and the same answer twice. */
      check("migrate: v1 to v2 is lossless and running it twice changes nothing", function () {
        var v1 = {
          schemaVersion: 1,
          createdAt: "2026-09-01",
          settings: { lang: "tr" },
          categories: [
            { id: "c_1", name: "Kira", kind: "expense", fixed: true, archived: false, futureField: "keep me" },
            { id: "c_2", name: "Maas", kind: "income", fixed: false, archived: false },
            { id: "c_3", name: "Market", kind: "expense", fixed: false, archived: false, color: "#123456" }
          ],
          entries: [{ id: "e_1", date: "2026-09-02", amount: 100, direction: "out", futureWing: 7 }],
          limits: [], recurring: [], goals: [], debts: [],
          futureTopLevel: { kept: true }
        };
        var once = MIGRATIONS[1](clone(v1));
        assert(once.schemaVersion === 2, "schemaVersion should be 2, got " + once.schemaVersion);
        assert(Array.isArray(once.accounts) && once.accounts.length === 0, "accounts must arrive empty");
        assert(Array.isArray(once.investments) && once.investments.length === 0, "investments must arrive empty");
        assert(once.categories[0].color === CATEGORY_SPECTRUM[0], "colours are dealt by position");
        assert(once.categories[1].color === CATEGORY_SPECTRUM[1], "and keep going round the spectrum");
        assert(once.categories[2].color === "#123456", "a colour already chosen must be left alone");
        assert(once.categories[0].icon === ICON_BY_KIND.expense, "an expense gets the expense icon");
        assert(once.categories[1].icon === ICON_BY_KIND.income, "and income gets the income one");
        assert(once.categories[0].futureField === "keep me", "an unknown field on a record it rewrites");
        assert(once.entries[0].futureWing === 7, "an unknown field on a record it does not touch");
        assert(once.futureTopLevel.kept === true, "and an unknown top-level field");
        var twice = MIGRATIONS[1](clone(once));
        assert(JSON.stringify(twice) === JSON.stringify(once), "the second run must change nothing");

        /* A collection that is there but is not a list is loss, and normalize
           is where that is reported; replacing it here would hide it. */
        var odd = MIGRATIONS[1]({ schemaVersion: 1, accounts: "not-a-list", categories: "not-a-list" });
        assert(odd.accounts === "not-a-list", "a non-list collection must be left for normalize");
        assert(odd.investments.length === 0, "and the missing one still added");
      });

      /* 8c — the same step through boot, and what it leaves on disk */
      check("boot: v1 data migrates to v2 and is written back as v2", function () {
        testStorage = makeShim({
          "moon.v1": JSON.stringify({
            schemaVersion: 1, createdAt: "2026-09-01", settings: { lang: "tr" },
            categories: [{ id: "c_1", name: "Kira", kind: "expense", fixed: true, archived: false }],
            entries: [{ id: "e_1", date: "2026-09-02", amount: 2500, direction: "out", categoryId: "c_1" }],
            limits: [], recurring: [], goals: [], debts: []
          })
        });
        var out = boot();
        assert(out.reason === "migrated", "reason should be migrated, got " + out.reason);
        assert(out.dropped === 0 && out.repaired === 0, "a clean v1 file needs no repair");
        assert(state.schemaVersion === 2, "the live state must be v2");
        assert(Array.isArray(state.accounts) && Array.isArray(state.investments), "both collections present");
        assert(state.categories[0].color === CATEGORY_SPECTRUM[0], "the category is dressed");
        assert(state.categories[0].icon === ICON_BY_KIND.expense, "icon as well");
        assert(state.entries[0].accountId === null, "an entry with no account reads as null");
        var onDisk = stored(testStorage);
        /* The written file is what an older Moon would find: at version 2 it
           refuses to overwrite it, which is the only thing stopping a v1 copy
           of the app from writing these records back without the new fields. */
        assert(onDisk.schemaVersion === 2, "v2 is what gets written, got " + onDisk.schemaVersion);
        assert(Array.isArray(onDisk.accounts) && Array.isArray(onDisk.investments), "and it carries both lists");
        assert(testStorage.raw["moon.v1.bak"], "a migrating boot snapshots the pre-migration file");
      });

      /* 8d — a hand-edited holding is repaired, never binned */
      check("import: a malformed account and holding are repaired, not dropped", function () {
        testStorage = makeShim();
        boot();
        var file = JSON.stringify({
          schemaVersion: 2,
          createdAt: "2026-09-01",
          settings: { lang: "tr", currency: "TRY", monthStartDay: 1 },
          categories: [], entries: [], limits: [], recurring: [], goals: [], debts: [],
          accounts: [
            { id: "a_1", name: "Garanti", kind: "bank", opening: 125000, currency: "try" },
            { id: "a_2", kind: "wallet", opening: "about three fifty" }
          ],
          investments: [{
            id: "i_1", name: "THYAO", kind: "shares",
            quantity: -1000, unitCost: 24500, unitPrice: null, priceDate: "whenever",
            note: "ilk alim", futureField: "keep me",
            history: [
              { date: "2026-09-04", unitPrice: 31200 },
              { date: "2026-09-02", unitPrice: 24500 },
              { date: "2026-09-04", unitPrice: 31500 },
              { date: "the fourth", unitPrice: 1 }
            ]
          }]
        });
        var out = importJson(file, { mode: "replace" });
        assert(out.ok === true, "the file must still import: " + out.error);
        assert(out.counts.accounts === 2, "both accounts arrive, got " + out.counts.accounts);
        assert(out.counts.investments === 1, "and the holding, got " + out.counts.investments);
        assert(out.counts.repaired > 0, "with the repairs reported");
        assert(out.counts.dropped === 1, "only the undated price row is lost, got " + out.counts.dropped);

        var holding = state.investments[0];
        assert(holding.quantity === 1000, "a negative quantity keeps its magnitude");
        assert(holding.kind === "other", "an unknown kind falls back to other");
        assert(holding.history.length === 2, "one date cannot hold two prices");
        assert(holding.history[0].date === "2026-09-02", "history is oldest first");
        assert(holding.history[1].unitPrice === 31500, "and the later row for a date wins");
        assert(holding.unitPrice === 31500, "a missing price is read off the history");
        assert(holding.priceDate === "2026-09-04", "and so is the day it was typed");
        assert(holding.futureField === "keep me", "unknown fields survive a holding too");
        assert(holding.icon === ICON_BY_INVESTMENT_KIND.other && !!holding.color, "and it comes out dressed");

        var account = state.accounts[1];
        assert(account.kind === "cash" && account.opening === 0, "an unreadable account is repaired");
        assert(!!account.name && !!account.icon && !!account.color, "and comes out nameable and dressed");
        assert(state.accounts[0].currency === "TRY", "a currency is stored uppercase");
        assert(state.accounts[0].opening === 125000, "a readable opening balance is left alone");
      });

      /* 8e — the two numbers a holding cannot be trusted to carry itself */
      check("fillInvestment: history is capped newest-first-out, quantity stays integer", function () {
        var report = { repaired: 0, dropped: 0, structural: 0 };
        var rows = [];
        for (var i = 0; i < HISTORY_MAX + 20; i += 1) {
          /* Built from a local Date so the dates are civil strings; a UTC slice
             would shift the first row into the previous year. */
          var day = new Date(2025, 0, 1 + i);
          rows.push({
            date: day.getFullYear() + "-" + pad2(day.getMonth() + 1) + "-" + pad2(day.getDate()),
            unitPrice: 1000 + i
          });
        }
        var capped = fillInvestment({
          id: "i_cap", name: "Fon", kind: "fund", quantity: 10000,
          unitCost: 1000, unitPrice: 1000 + rows.length - 1, history: rows
        }, "tr", report);
        assert(capped.history.length === HISTORY_MAX, "capped at " + HISTORY_MAX + ", got " + capped.history.length);
        assert(capped.history[0].unitPrice === 1020, "the oldest rows are the ones that go");
        assert(capped.history[HISTORY_MAX - 1].unitPrice === 1000 + rows.length - 1, "the newest row stays");
        assert(report.dropped === 20, "the trimmed rows are reported as lost, got " + report.dropped);

        var second = { repaired: 0, dropped: 0, structural: 0 };
        var half = fillInvestment({
          id: "i_half", name: "BTC", kind: "crypto", quantity: 0.5, unitCost: 1, unitPrice: 1
        }, "tr", second);
        assert(isInt(half.quantity), "a fractional quantity must come out an integer");
        assert(second.repaired > 0, "and be reported: half a stored unit is not half a coin");
        assert(half.history.length === 0, "an empty history is left empty, not invented");
      });

      /* 9 — quota */
      check("quota: the change stays in memory and the app shouts", function () {
        testStorage = makeShim();
        boot();
        var tap = listen();
        testStorage.failNext = 1; /* the boot write already used the snapshot slot */
        var result = update(function (draft) {
          draft.entries.push({ id: "e_q", date: "2026-09-27", amount: 500, direction: "out" });
        }, { immediate: true });
        tap.stop();
        assert(result !== null, "update itself must not fail");
        assert(state.entries.length === 1, "the entry must stay on screen");
        assert(status.quotaHit === true, "status.quotaHit must be set");
        assert(tap.kinds().indexOf("quota") !== -1, "store:error kind quota expected");
        assert(status.lastError.messageKey === ERR.quota, "lastError should be the quota key");
        var after = persistNow();
        assert(after.ok === true && status.quotaHit === false, "a later write clears the flag");
        assert(stored(testStorage).entries.length === 1, "and lands the entry");
      });

      /* 10 — session backup taken once, before the first write */
      check("backup: one snapshot per session, taken before the first write", function () {
        /* Boot on existing data: that is the state worth snapshotting. A fresh
           install has nothing to preserve, so no snapshot is taken there. The
           data is current-schema on purpose — a migrating boot takes its own
           forced snapshot before touching anything, which is a different
           promise, checked where the migration is checked. */
        testStorage = makeShim({
          "moon.v1": JSON.stringify({
            schemaVersion: SCHEMA_VERSION, createdAt: "2026-09-01", settings: { lang: "tr" },
            categories: [{
              id: "c_1", name: "Market", kind: "expense", fixed: false, archived: false,
              color: CATEGORY_SPECTRUM[0], icon: ICON_BY_KIND.expense
            }],
            entries: [], limits: [], recurring: [], goals: [], debts: [], accounts: [], investments: []
          })
        });
        boot();
        var baseline = testStorage.raw["moon.v1"];
        assert(!testStorage.raw["moon.v1.bak"], "no snapshot before the first update");
        update(function (draft) {
          draft.entries.push({ id: "e_b1", date: "2026-09-20", amount: 111, direction: "out" });
        }, { immediate: true });
        assert(testStorage.raw["moon.v1.bak"] === baseline, "snapshot is the pre-write state");
        update(function (draft) {
          draft.entries.push({ id: "e_b2", date: "2026-09-21", amount: 222, direction: "out" });
        }, { immediate: true });
        assert(testStorage.raw["moon.v1.bak"] === baseline, "the snapshot must not be retaken");
      });

      /* 11 — export shape */
      check("export: field order, indent, exportedAt, filename", function () {
        testStorage = makeShim();
        boot();
        var text = exportJson();
        var keys = Object.keys(JSON.parse(text));
        assert(keys[0] === "schemaVersion", "schemaVersion must come first");
        assert(keys[1] === "createdAt" && keys[2] === "settings", "then createdAt, settings");
        assert(keys[keys.length - 1] === "exportedAt", "exportedAt must come last");
        assert(text.indexOf('\n  "createdAt"') !== -1, "2-space indent expected");
        assert(/^moon-yedek-\d{4}-\d{2}-\d{2}\.json$/.test(exportFilename()), "filename shape");
      });

      /* 12 — replace round trip */
      check("import replace: a backup restores the same data", function () {
        testStorage = makeShim();
        boot();
        var catId = state.categories[3].id;
        update(function (draft) {
          draft.entries.push({ id: "e_r1", date: "2026-09-11", amount: 4500, direction: "out", categoryId: catId });
          draft.limits.push({ id: "l_1", categoryId: catId, amount: 600000 });
        }, { immediate: true });
        var backupText = exportJson();
        wipe();
        assert(state.entries.length === 0, "wipe should empty the ledger");
        var out = importJson(backupText, { mode: "replace" });
        assert(out.ok, "import should succeed: " + out.error);
        assert(out.counts.entries === 1 && out.counts.limits === 1, "counts should report the rows");
        assert(state.entries[0].amount === 4500 && state.limits[0].amount === 600000, "amounts restored");
        assert(state.settings.changesSinceBackup === 0, "a restore is not an unsaved change");
        assert(stored(testStorage).entries.length === 1, "restore is persisted");
      });

      /* 13 — merge */
      check("import merge: id clashes skipped, same-name categories folded", function () {
        testStorage = makeShim();
        boot();
        /* "Market" on purpose: no dotted/dotless I, so the fold is proved by
           case folding itself and not by the Turkish lowercase rule. */
        update(function (draft) {
          draft.categories.push({ id: "c_local", name: "Market", kind: "expense", fixed: false, archived: false });
          draft.entries.push({ id: "e_dup", date: "2026-09-01", amount: 100, direction: "out", categoryId: "c_local" });
        }, { immediate: true });
        var before = state.categories.length;
        /* Settings the install does not have, so "merge leaves settings alone"
           is provable whichever language the install defaults to. */
        var settingsBefore = {
          lang: state.settings.lang,
          currency: state.settings.currency
        };
        var foreign = JSON.stringify({
          schemaVersion: 1,
          settings: { lang: "zz", currency: "EUR" },
          categories: [
            { id: "c_foreign", name: "  MARKET  ", kind: "expense" },
            { id: "c_new", name: "Kitaplar", kind: "expense" }
          ],
          entries: [
            { id: "e_dup", date: "2026-09-01", amount: 100, direction: "out", categoryId: "c_foreign" },
            { id: "e_fresh", date: "2026-09-02", amount: 7700, direction: "out", categoryId: "c_foreign" },
            { id: "e_fresh2", date: "2026-09-03", amount: 1200, direction: "out", categoryId: "c_new" }
          ]
        });
        var out = importJson(foreign, { mode: "merge" });
        assert(out.ok, "merge should succeed: " + out.error);
        assert(out.counts.skipped === 1, "the clashing id should be skipped, got " + out.counts.skipped);
        assert(out.counts.mergedCategories === 1, "the same-name category should fold");
        assert(out.counts.categories === 1 && state.categories.length === before + 1, "only the new category is added");
        assert(state.entries.length === 3, "two new entries expected");
        var remapped = state.entries.filter(function (e) {
          return e.id === "e_fresh";
        })[0];
        assert(remapped.categoryId === "c_local", "the folded category id must be remapped");
        assert(state.settings.lang === settingsBefore.lang &&
          state.settings.currency === settingsBefore.currency,
          "merge must not overwrite settings");
      });

      /* 14 — a bad file changes nothing */
      check("import: an invalid file leaves the data alone", function () {
        testStorage = makeShim();
        boot();
        update(function (draft) {
          draft.entries.push({ id: "e_keep", date: "2026-09-15", amount: 333, direction: "out" });
        }, { immediate: true });
        var snapshot = JSON.stringify(serialize(state));
        [null, "", "not json at all", "{}", "[1,2,3]", '{"schemaVersion":1}'].forEach(function (bad) {
          var out = importJson(bad, { mode: "replace" });
          assert(out.ok === false, "should refuse: " + String(bad));
          assert(out.error === "data.import.badFile", "error key should be data.import.badFile");
        });
        assert(JSON.stringify(serialize(state)) === snapshot, "state must be untouched");
      });

      /* 14b — rows normalize could not read are counted, not swallowed, and a
               replace keeps the reader's own data under the backup key. */
      check("import: unreadable rows are reported, replace keeps a copy", function () {
        testStorage = makeShim();
        boot();
        update(function (draft) {
          draft.entries.push({
            id: "e_mine", date: "2026-09-15", amount: 999, direction: "out",
            categoryId: draft.categories[0].id, note: "READER ROW"
          });
        }, { immediate: true });

        var file = JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          createdAt: "2026-09-01",
          settings: { lang: "tr", currency: "TRY", monthStartDay: 1 },
          categories: [{ id: "c_x", name: "X", kind: "expense", fixed: false, archived: false }],
          entries: [
            { id: "e_ok", date: "2026-09-10", amount: 1000, direction: "out", categoryId: "c_x" },
            /* amount as a decimal string and a d/m/Y date: neither survives
               normalize, and both used to vanish without a word. */
            { id: "e_bad1", date: "2026-09-10", amount: "12.50", direction: "out", categoryId: "c_x" },
            { id: "e_bad2", date: "10/09/2026", amount: 2000, direction: "out", categoryId: "c_x" }
          ],
          limits: [], recurring: [], goals: [], debts: []
        });

        var tap = listen();
        var out = importJson(file, { mode: "replace" });
        tap.stop();
        assert(out.ok === true, "a mostly-readable file still imports");
        assert(out.counts.entries === 1, "one row arrived, got " + out.counts.entries);
        assert(out.counts.dropped === 2, "two rows were lost, got " + out.counts.dropped);
        var kept = testStorage.raw[BACKUP_KEY];
        assert(!!kept && kept.indexOf("READER ROW") !== -1,
          "replace must leave the reader's data under the backup key");

        /* A clean round trip reports nothing lost. */
        testStorage = makeShim();
        boot();
        var clean = importJson(exportJson(), { mode: "merge" });
        assert(clean.counts.dropped === 0 && clean.counts.repaired === 0,
          "a file we wrote ourselves needs no repair");
        assert(importJson("not json", { mode: "merge" }).counts.dropped === 0,
          "a refused file reports the empty shape");
      });

      /* 15 — wipe */
      check("wipe: keys removed, defaults installed, preferences kept", function () {
        testStorage = makeShim();
        boot();
        update(function (draft) {
          draft.settings.theme = "paper";
          draft.settings.currency = "EUR";
          draft.entries.push({ id: "e_w", date: "2026-09-18", amount: 900, direction: "out" });
        }, { immediate: true });
        wipe();
        assert(!testStorage.raw["moon.v1.bak"], "the backup key must go");
        assert(!testStorage.raw["moon.probe"], "the probe key must go");
        assert(state.entries.length === 0 && state.categories.length === 13, "defaults reinstalled");
        assert(state.settings.theme === "paper" && state.settings.currency === "EUR", "preferences kept");
        assert(state.settings.changesSinceBackup === 0, "counter reset");
        assert(stored(testStorage).entries.length === 0, "the fresh state is persisted");
      });

      /* 15b — "erase everything" has to include the quarantined block, and
                until it does the Data section can read and download it. */
      check("wipe: the quarantined block goes too", function () {
        testStorage = makeShim({ "moon.v1": "{half written and quite long" });
        boot();
        var blocks = quarantinedBlocks();
        assert(blocks.length === 1, "boot should have set one block aside");
        assert(blocks[0].bytes === "{half written and quite long".length, "byte count");
        assert(readQuarantined(blocks[0].key) === "{half written and quite long",
          "the raw bytes must be readable, that is the whole promise");
        assert(readQuarantined(KEY) === null, "only quarantine keys are readable this way");
        assert(dropQuarantined(KEY) === false, "and only they can be dropped");
        var before = usage();
        assert(before.bytes > 0, "the block counts against storage");

        wipe();
        assert(quarantinedBlocks().length === 0, "wipe must take the block as well");
        assert(session.quarantined.length === 0, "and forget it");
        assert(Object.keys(testStorage.raw).filter(function (key) {
          return key.indexOf(CORRUPT_PREFIX) === 0;
        }).length === 0, "no corrupt key may survive an erase");
        assert(usage().keys.length === 1, "only the live key is left, got " + usage().keys.length);
      });

      /* 16 — storage refused entirely. Current-schema data, so what is under
              test is the blocked storage and not what boot calls a session that
              had to migrate on the way in as well. */
      check("boot: blocked storage degrades to a memory session", function () {
        var shim = makeShim({
          "moon.v1": JSON.stringify({
            schemaVersion: SCHEMA_VERSION, settings: { lang: "tr" }, categories: [],
            entries: [{ id: "e_ro", date: "2026-09-19", amount: 4242, direction: "out" }]
          })
        });
        shim.failAlways = true;
        testStorage = shim;
        var tap = listen();
        var out = boot();
        assert(out.ok === true, "boot must still report ok");
        assert(out.readOnly === true, "readOnly expected");
        assert(out.reason === "readonly", "reason should be readonly, got " + out.reason);
        assert(tap.kinds().indexOf("readonly") !== -1, "store:error kind readonly expected");
        assert(state.entries.length === 1 && state.entries[0].amount === 4242, "readable data still shown");
        var result = update(function (draft) {
          draft.entries.push({ id: "e_mem", date: "2026-09-20", amount: 7, direction: "out" });
        }, { immediate: true });
        tap.stop();
        assert(result !== null && state.entries.length === 2, "the app keeps working in memory");
        assert(exportJson().indexOf("e_mem") !== -1, "and can still export");
      });

      /* 17 — a throwing mutator leaves no half change */
      check("update: a throwing mutator leaves the state intact", function () {
        testStorage = makeShim();
        boot();
        var before = JSON.stringify(serialize(state));
        var out = update(function (draft) {
          draft.entries.push({ id: "e_half", date: "2026-09-21", amount: 10, direction: "out" });
          throw new Error("mutator blew up");
        }, { immediate: true });
        assert(out === null, "update should report failure");
        assert(JSON.stringify(serialize(state)) === before, "no half mutation may remain");
      });
    } finally {
      writeSoon.cancel();
      cancelIdle();
      testStorage = null;
      state = savedState;
      backend = savedBackend;
      status.readOnly = savedStatus.readOnly;
      status.quotaHit = savedStatus.quotaHit;
      status.lastError = savedStatus.lastError;
      session.backupTaken = savedSession.backupTaken;
      session.quarantined = savedSession.quarantined;
    }

    var failed = results.filter(function (one) {
      return !one.ok;
    });
    return {
      ok: failed.length === 0,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results: results
    };
  };
})(window);
