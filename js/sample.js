/* Moon — sample month.
 *
 * A made-up but plausible Turkish month (2026 prices) so a visitor can read the
 * instrument before typing anything: one category lands over its limit, another
 * sits just under it, weekends carry the heavy shopping so the day seismograph
 * shows a pattern, and three fixed payments prove the allowance pool excludes
 * them.
 *
 * Every record carries source:"sample" and a "_sample_" id, which is the only
 * thing clear() looks at — the reader's own entries are never in scope.
 *
 * The note texts here are DATA, not interface copy, so they live in this file
 * as tr/en pairs rather than in the i18n catalogs.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var util = Moon.util;

  function dates() { return Moon.Dates; }
  function store() { return Moon.Store; }

  function lang() {
    return Moon.I18n && Moon.I18n.lang === "en" ? "en" : "tr";
  }

  /* --------------------------------------------------------------- content */

  var CATEGORIES = [
    { key: "rent", kind: "expense", fixed: true, tr: "Kira", en: "Rent" },
    { key: "bills", kind: "expense", fixed: true, tr: "Faturalar", en: "Bills" },
    { key: "subs", kind: "expense", fixed: true, tr: "Abonelikler", en: "Subscriptions" },
    { key: "groceries", kind: "expense", fixed: false, tr: "Market", en: "Groceries" },
    { key: "eatingOut", kind: "expense", fixed: false, tr: "Yemek", en: "Eating out" },
    { key: "transport", kind: "expense", fixed: false, tr: "Ulaşım", en: "Transport" },
    { key: "health", kind: "expense", fixed: false, tr: "Sağlık", en: "Health" },
    { key: "home", kind: "expense", fixed: false, tr: "Ev", en: "Home" },
    { key: "fun", kind: "expense", fixed: false, tr: "Eğlence", en: "Fun" },
    { key: "salary", kind: "income", fixed: false, tr: "Maaş", en: "Salary" },
    { key: "side", kind: "income", fixed: false, tr: "Serbest gelir", en: "Freelance" }
  ];

  /* Eight limits. Groceries ends the month at 108% (the overflow mark is meant
     to be seen) and eating out at 90% (the warning shade). Subscriptions get no
     limit on purpose, so the limitless row is exercised too. */
  var LIMITS = {
    rent: 1800000,
    bills: 450000,
    groceries: 600000,
    eatingOut: 250000,
    transport: 150000,
    health: 80000,
    home: 120000,
    fun: 100000
  };

  /* day: index into the elapsed days of the period.
     dow + week: the (week+1)-th weekday of the period — 6 = Saturday, 0 = Sunday,
     5 = Friday — which is what puts the big shops and dinners on real weekends.
     `day` is also the fallback when a period has no such weekday. */
  var ENTRIES = [
    /* fixed: rent, five bills, five subscriptions */
    { cat: "rent", day: 0, amount: 1800000, tr: "Kira ödemesi", en: "Rent payment" },
    { cat: "bills", day: 3, amount: 142050, tr: "Elektrik faturası", en: "Electricity bill" },
    { cat: "bills", day: 4, amount: 39999, tr: "İnternet faturası", en: "Internet bill" },
    { cat: "bills", day: 5, amount: 48900, tr: "Su faturası", en: "Water bill" },
    { cat: "bills", day: 6, amount: 87500, tr: "Doğalgaz faturası", en: "Gas bill" },
    { cat: "bills", day: 9, amount: 34900, tr: "Telefon hattı", en: "Mobile line" },
    { cat: "subs", day: 7, amount: 2999, tr: "Bulut depolama", en: "Cloud storage" },
    { cat: "subs", day: 11, amount: 19999, tr: "Dizi platformu", en: "Streaming service" },
    { cat: "subs", day: 14, amount: 6999, tr: "Müzik aboneliği", en: "Music subscription" },
    { cat: "subs", day: 17, amount: 8999, tr: "Video aboneliği", en: "Video subscription" },
    { cat: "subs", day: 20, amount: 5999, tr: "Oyun aboneliği", en: "Game subscription" },

    /* groceries — 648.000 against a 600.000 limit */
    { cat: "groceries", dow: 6, week: 0, day: 5, amount: 124890, tr: "A101 haftalık alışveriş", en: "Weekly shop" },
    { cat: "groceries", dow: 6, week: 1, day: 12, amount: 103750, tr: "BİM haftalık alışveriş", en: "Weekly shop" },
    { cat: "groceries", dow: 6, week: 2, day: 19, amount: 85900, tr: "Zincir market alışverişi", en: "Supermarket run" },
    { cat: "groceries", dow: 0, week: 1, day: 13, amount: 96430, tr: "Pazar, sebze meyve", en: "Market stall, produce" },
    { cat: "groceries", day: 1, amount: 24890, tr: "Market, ara alışveriş", en: "Corner shop top-up" },
    { cat: "groceries", day: 2, amount: 18750, tr: "Ekmek ve süt", en: "Bread and milk" },
    { cat: "groceries", day: 4, amount: 31200, tr: "Kasap, tavuk", en: "Butcher, chicken" },
    { cat: "groceries", day: 6, amount: 42300, tr: "Bakliyat ve kuruyemiş", en: "Pulses and nuts" },
    { cat: "groceries", day: 8, amount: 29600, tr: "Market, ara alışveriş", en: "Corner shop top-up" },
    { cat: "groceries", day: 9, amount: 15690, tr: "Fırın", en: "Bakery" },
    { cat: "groceries", day: 11, amount: 12600, tr: "Yumurta ve peynir", en: "Eggs and cheese" },
    { cat: "groceries", day: 13, amount: 8760, tr: "Ekmek", en: "Bread" },
    { cat: "groceries", day: 15, amount: 6540, tr: "Damacana su", en: "Water bottles" },
    { cat: "groceries", day: 18, amount: 11700, tr: "Kahvaltılık", en: "Breakfast things" },
    { cat: "groceries", day: 21, amount: 21400, tr: "Manav", en: "Greengrocer" },
    { cat: "groceries", day: 24, amount: 13600, tr: "Şarküteri", en: "Deli counter" },

    /* eating out — 225.500 against a 250.000 limit (90%) */
    { cat: "eatingOut", dow: 6, week: 0, day: 5, amount: 48900, tr: "Akşam yemeği, iki kişi", en: "Dinner for two" },
    { cat: "eatingOut", dow: 6, week: 2, day: 19, amount: 38200, tr: "Akşam yemeği", en: "Dinner out" },
    { cat: "eatingOut", dow: 5, week: 1, day: 11, amount: 22400, tr: "Pide, akşam", en: "Flatbread, evening" },
    { cat: "eatingOut", day: 2, amount: 18600, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", day: 5, amount: 16500, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", day: 8, amount: 14750, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", day: 12, amount: 12300, tr: "Döner, öğle", en: "Kebab, lunch" },
    { cat: "eatingOut", day: 16, amount: 10750, tr: "Kahve ve tatlı", en: "Coffee and cake" },
    { cat: "eatingOut", day: 19, amount: 10200, tr: "Filtre kahve", en: "Filter coffee" },
    { cat: "eatingOut", day: 22, amount: 9800, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", day: 25, amount: 8900, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", day: 27, amount: 7400, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", day: 29, amount: 6800, tr: "Kahve", en: "Coffee" },

    /* transport — 98.000 of 150.000 */
    { cat: "transport", day: 1, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", day: 7, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", day: 13, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", dow: 6, week: 3, day: 26, amount: 10500, tr: "Taksi, gece", en: "Taxi, late" },
    { cat: "transport", day: 10, amount: 9500, tr: "Otobüs kart yükleme", en: "Bus card top-up" },
    { cat: "transport", day: 19, amount: 10000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", day: 16, amount: 4500, tr: "Dolmuş", en: "Shared minibus" },
    { cat: "transport", day: 23, amount: 3500, tr: "Dolmuş", en: "Shared minibus" },

    /* health, home, fun */
    { cat: "health", day: 6, amount: 18450, tr: "Eczane, vitamin", en: "Pharmacy, vitamins" },
    { cat: "health", day: 17, amount: 8050, tr: "Eczane, ağrı kesici", en: "Pharmacy, painkillers" },
    { cat: "health", day: 26, amount: 4500, tr: "Eczane, bant", en: "Pharmacy, plasters" },
    { cat: "home", day: 4, amount: 24900, tr: "Temizlik malzemesi", en: "Cleaning supplies" },
    { cat: "home", day: 12, amount: 18600, tr: "Hırdavat, ampul", en: "Hardware, bulbs" },
    { cat: "home", day: 20, amount: 15500, tr: "Nevresim takımı", en: "Bed linen" },
    { cat: "home", day: 28, amount: 8000, tr: "Çöp poşeti ve deterjan", en: "Bin bags and detergent" },
    { cat: "fun", dow: 0, week: 2, day: 20, amount: 16000, tr: "Sinema, iki bilet", en: "Cinema, two tickets" },
    { cat: "fun", day: 9, amount: 13500, tr: "Kitap", en: "Book" },
    { cat: "fun", dow: 6, week: 3, day: 26, amount: 8500, tr: "Konser bileti", en: "Concert ticket" },
    { cat: "fun", day: 22, amount: 4000, tr: "Dergi", en: "Magazine" },

    /* income */
    { cat: "salary", day: 0, direction: "in", amount: 4200000, tr: "Maaş", en: "Monthly salary" },
    { cat: "side", day: 17, direction: "in", amount: 850000, tr: "Serbest iş ödemesi", en: "Freelance invoice" }
  ];

  var RECURRING = [
    { key: "rent", cat: "rent", dayOfMonth: 1, amount: 1800000, tr: "Kira", en: "Rent" },
    { key: "internet", cat: "bills", dayOfMonth: 4, amount: 39999, tr: "İnternet faturası", en: "Internet bill" },
    { key: "music", cat: "subs", dayOfMonth: 14, amount: 6999, tr: "Müzik aboneliği", en: "Music subscription" }
  ];

  var GOALS = [
    {
      key: "trip", tr: "Yaz tatili", en: "Summer trip",
      targetAmount: 2000000, dueIn: 9,
      contributions: [{ day: 1, amount: 300000 }, { day: 10, amount: 150000 }]
    },
    {
      key: "laptop", tr: "Yeni dizüstü", en: "New laptop",
      targetAmount: 3500000, dueIn: 4,
      contributions: [{ day: 2, amount: 800000 }, { day: 12, amount: 400000 }]
    }
  ];

  /* No real people: the counterparty is a role, never a name, and there is no
     account number, card or address anywhere in this file. */
  var DEBTS = [
    {
      key: "flat", tr: "Ev arkadaşı", en: "Flatmate", amount: 50000,
      direction: "owedToMe", day: 3, dueIn: 1,
      noteTr: "Ortak fatura payı", noteEn: "Shared bill"
    },
    {
      key: "work", tr: "İş arkadaşı", en: "Colleague", amount: 120000,
      direction: "iOwe", day: 7, dueIn: 1,
      noteTr: "Öğle yemeği ve bilet", noteEn: "Lunch and tickets"
    }
  ];

  /* ---------------------------------------------------------------- helpers */

  var MARK = "_sample_";

  function isSampleRecord(record) {
    if (!record) return false;
    if (record.source === "sample") return true;
    return String(record.id || "").indexOf(MARK) === 1;
  }

  function catId(key) { return "c" + MARK + key; }

  function dayOfWeek(date) {
    var d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
    return d.getDay();
  }

  /* `scale` compresses the authored day indices into however much of the period
     has actually elapsed, so opening the sample on the 8th spreads the month
     across eight days instead of stacking two thirds of it onto today. */
  function pickDate(days, spec, scale) {
    if (!days.length) return null;
    var wanted = spec.day === undefined ? 0 : spec.day;
    if (scale > 0 && scale < 1) wanted = Math.round(wanted * scale);
    var fallback = days[util.clamp(wanted, 0, days.length - 1)];
    if (spec.dow === undefined) return fallback;
    var hits = days.filter(function (date) { return dayOfWeek(date) === spec.dow; });
    if (!hits.length) return fallback;
    return hits[util.clamp(spec.week || 0, 0, hits.length - 1)];
  }

  function periodStart(periodKey, offset) {
    var d = dates();
    if (!d || !d.shiftPeriod || !d.periodRange) return null;
    var range = d.periodRange(d.shiftPeriod(periodKey, offset), 1);
    return range ? range.start : null;
  }

  function stamp() {
    return new Date().toISOString();
  }

  /* ------------------------------------------------------------------ build */

  function build(periodKey) {
    var out = { categories: [], entries: [], limits: [], recurring: [], goals: [], debts: [] };
    var d = dates();
    if (!d || !d.periodRange || !d.eachDay || !periodKey) return out;

    var msd = 1;
    var st = store();
    if (st && st.state && st.state.settings) {
      var configured = st.state.settings.monthStartDay;
      if (typeof configured === "number" && configured >= 1 && configured <= 28) msd = configured;
    }

    var range = d.periodRange(periodKey, msd);
    if (!range) return out;

    var all = d.eachDay(range.start, range.end) || [];
    if (!all.length) return out;

    /* Only the elapsed part of a running period gets entries. Otherwise the
       totals would count spending the charts (which stop at today) cannot show,
       and the hero number would disagree with its own trail. */
    var today = d.today ? d.today() : null;
    var days = all;
    if (today && today >= range.start && today < range.end) {
      var cut = all.indexOf(today);
      if (cut >= 0) days = all.slice(0, cut + 1);
    }
    var scale = all.length > 1 ? (days.length - 1) / (all.length - 1) : 1;

    var code = lang();
    var fixedByKey = Object.create(null);

    CATEGORIES.forEach(function (cat) {
      fixedByKey[cat.key] = cat.fixed;
      out.categories.push({
        id: catId(cat.key),
        name: cat[code],
        kind: cat.kind,
        fixed: cat.fixed,
        archived: false,
        source: "sample"
      });
    });

    Object.keys(LIMITS).forEach(function (key) {
      out.limits.push({
        id: "l" + MARK + key,
        categoryId: catId(key),
        amount: LIMITS[key],
        source: "sample"
      });
    });

    var created = stamp();
    ENTRIES.forEach(function (spec, index) {
      var date = pickDate(days, spec, scale);
      if (!date) return;
      out.entries.push({
        id: "e" + MARK + util.pad2(index + 1),
        date: date,
        amount: spec.amount,
        direction: spec.direction === "in" ? "in" : "out",
        categoryId: catId(spec.cat),
        note: spec[code],
        fixed: !!fixedByKey[spec.cat],
        source: "sample",
        confirmed: true,
        recurringId: null,
        createdAt: created
      });
    });

    var start = periodStart(periodKey, -6) || range.start;
    RECURRING.forEach(function (spec) {
      out.recurring.push({
        id: "r" + MARK + spec.key,
        name: spec[code],
        amount: spec.amount,
        direction: "out",
        categoryId: catId(spec.cat),
        dayOfMonth: spec.dayOfMonth,
        fixed: true,
        startDate: start,
        endDate: null,
        active: true,
        /* Already stamped for this period: the sample ships its own fixed
           entries, so generateRecurring must not add a second copy. */
        lastGeneratedPeriod: periodKey,
        source: "sample"
      });
    });

    GOALS.forEach(function (spec) {
      var contributions = [];
      var saved = 0;
      spec.contributions.forEach(function (c) {
        var date = pickDate(days, { day: c.day }, scale);
        if (!date) return;
        contributions.push({ date: date, amount: c.amount });
        saved += c.amount;
      });
      out.goals.push({
        id: "g" + MARK + spec.key,
        name: spec[code],
        targetAmount: spec.targetAmount,
        savedAmount: saved,
        dueDate: periodStart(periodKey, spec.dueIn),
        contributions: contributions,
        source: "sample"
      });
    });

    DEBTS.forEach(function (spec) {
      out.debts.push({
        id: "d" + MARK + spec.key,
        person: spec[code],
        amount: spec.amount,
        direction: spec.direction,
        date: pickDate(days, { day: spec.day }, scale),
        dueDate: periodStart(periodKey, spec.dueIn),
        settled: false,
        settledDate: null,
        note: code === "en" ? spec.noteEn : spec.noteTr,
        source: "sample"
      });
    });

    return out;
  }

  /* ------------------------------------------------------------ apply/clear */

  var BUCKETS = ["categories", "entries", "limits", "recurring", "goals", "debts"];

  function currentPeriod() {
    var d = dates();
    if (!d || !d.today || !d.periodKey) return null;
    var st = store();
    var msd = 1;
    if (st && st.state && st.state.settings) {
      var configured = st.state.settings.monthStartDay;
      if (typeof configured === "number" && configured >= 1 && configured <= 28) msd = configured;
    }
    return d.periodKey(d.today(), msd);
  }

  function isOn() {
    var st = store();
    var data = st && st.state ? st.state : null;
    if (!data) return false;
    if (data.settings && data.settings.sampleOn) return true;
    return (Array.isArray(data.entries) ? data.entries : []).some(isSampleRecord);
  }

  /* Adds alongside whatever is already there. Nothing existing is read, moved
     or rewritten — the two sets only ever share the screen. */
  function apply() {
    var st = store();
    if (!st || !st.update) return 0;
    if (isOn()) return 0;

    var periodKey = currentPeriod();
    if (!periodKey) return 0;

    var data = build(periodKey);
    if (!data.entries.length) return 0;

    st.update(function (draft) {
      BUCKETS.forEach(function (name) {
        if (!Array.isArray(draft[name])) draft[name] = [];
        data[name].forEach(function (record) { draft[name].push(record); });
      });
      if (!draft.settings) draft.settings = {};
      draft.settings.sampleOn = true;
    }, { reason: "sample:apply", immediate: true });

    return data.entries.length;
  }

  function clear() {
    var st = store();
    if (!st || !st.update) return 0;

    var removed = 0;
    st.update(function (draft) {
      BUCKETS.forEach(function (name) {
        var rows = draft[name];
        if (!Array.isArray(rows)) return;
        for (var i = rows.length - 1; i >= 0; i -= 1) {
          if (isSampleRecord(rows[i])) {
            rows.splice(i, 1);
            removed += 1;
          }
        }
      });
      if (!draft.settings) draft.settings = {};
      draft.settings.sampleOn = false;
    }, { reason: "sample:clear", immediate: true });

    return removed;
  }

  Moon.Sample = {
    build: build,
    apply: apply,
    clear: clear,
    isOn: isOn
  };
})(window);
