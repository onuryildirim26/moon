/* Moon — sample month.
 *
 * A made-up but plausible Turkish month (2026 prices) so a visitor can read the
 * instrument before typing anything: one category lands over its limit, another
 * sits just under it, weekends carry the heavy shopping so the day seismograph
 * shows a pattern, and three fixed payments prove the allowance pool excludes
 * them.
 *
 * It is also a balance sheet. Four accounts carry the month's spending — a
 * current account for the fixed payments and the salary, a wallet for the small
 * shops, a credit card that starts the month owing money, and savings that only
 * ever take money in — and six holdings across six kinds carry half a year of
 * typed prices, one of them below what it cost. Without those two sets the
 * accounts and investments screens open empty in the demo, which teaches a
 * visitor that Moon cannot do what the home screen says it does.
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

  /* Accounts and holdings carry a currency of their own, and nothing in Moon
     converts between them. Writing the reader's configured code means the
     sample's cards are labelled in the same unit the formatter prints every
     amount in; writing a literal "TRY" would label a demo in lira for someone
     who has set the app to pounds. */
  function currency() {
    var st = store();
    var code = st && st.state && st.state.settings ? st.state.settings.currency : null;
    return typeof code === "string" && /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : "TRY";
  }

  /* --------------------------------------------------------------- content */

  /* `tone` is an index into the store's ten-colour spectrum rather than a hex
     string, so the demo can never drift off the palette the stylesheet exposes
     as --cat-1 … --cat-10. The icons are chosen per category for the same
     reason the seed set chooses them: a visitor reads a list of pictures faster
     than a list of words, and that is most of what makes the screen look like
     the apps the owner compared Moon with. */
  var CATEGORIES = [
    { key: "rent", kind: "expense", fixed: true, tone: 0, icon: "🏠", tr: "Kira", en: "Rent" },
    { key: "bills", kind: "expense", fixed: true, tone: 1, icon: "💡", tr: "Faturalar", en: "Bills" },
    { key: "subs", kind: "expense", fixed: true, tone: 2, icon: "🔁", tr: "Abonelikler", en: "Subscriptions" },
    { key: "groceries", kind: "expense", fixed: false, tone: 3, icon: "🛒", tr: "Market", en: "Groceries" },
    { key: "eatingOut", kind: "expense", fixed: false, tone: 4, icon: "🍔", tr: "Yemek", en: "Eating out" },
    { key: "transport", kind: "expense", fixed: false, tone: 5, icon: "🚌", tr: "Ulaşım", en: "Transport" },
    { key: "health", kind: "expense", fixed: false, tone: 6, icon: "🩺", tr: "Sağlık", en: "Health" },
    { key: "home", kind: "expense", fixed: false, tone: 7, icon: "🪴", tr: "Ev", en: "Home" },
    { key: "fun", kind: "expense", fixed: false, tone: 9, icon: "🎬", tr: "Eğlence", en: "Fun" },
    { key: "salary", kind: "income", fixed: false, tone: 1, icon: "💰", tr: "Maaş", en: "Salary" },
    { key: "side", kind: "income", fixed: false, tone: 2, icon: "📥", tr: "Serbest gelir", en: "Freelance" }
  ];

  /* Four accounts, because four is what it takes to show the whole shape: one
     that takes the salary and pays the fixed bills, one that is only ever
     counted down, one that starts BELOW zero (a card is a debt, and the net
     worth card has to be able to show that), and one that nothing is ever spent
     from. The openings are chosen so that every balance reads believably once
     the month's entries have moved through it — a wallet that ends the month at
     minus six hundred lira would teach a visitor to distrust the arithmetic. */
  var ACCOUNTS = [
    { key: "bank", kind: "bank", tone: 0, opening: 640000, tr: "Vadesiz hesap", en: "Current account" },
    { key: "cash", kind: "cash", tone: 1, opening: 520000, tr: "Nakit", en: "Cash" },
    { key: "card", kind: "card", tone: 2, opening: -420000, tr: "Kredi kartı", en: "Credit card" },
    { key: "savings", kind: "savings", tone: 5, opening: 2400000, tr: "Birikim", en: "Savings" }
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
     `day` is also the fallback when a period has no such weekday.
     acc: which of the four accounts the money moved through. Two rows leave it
     out, because an entry without an account is a legitimate record (§3.2) and a
     demo in which every single row has one would hide that. */
  var ENTRIES = [
    /* fixed: rent, five bills, five subscriptions — all direct from the account
       the salary lands in, which is what makes the fixed block legible there */
    { cat: "rent", acc: "bank", day: 0, amount: 1800000, tr: "Kira ödemesi", en: "Rent payment" },
    { cat: "bills", acc: "bank", day: 3, amount: 142050, tr: "Elektrik faturası", en: "Electricity bill" },
    { cat: "bills", acc: "bank", day: 4, amount: 39999, tr: "İnternet faturası", en: "Internet bill" },
    { cat: "bills", acc: "bank", day: 5, amount: 48900, tr: "Su faturası", en: "Water bill" },
    { cat: "bills", acc: "bank", day: 6, amount: 87500, tr: "Doğalgaz faturası", en: "Gas bill" },
    { cat: "bills", acc: "bank", day: 9, amount: 34900, tr: "Telefon hattı", en: "Mobile line" },
    { cat: "subs", acc: "bank", day: 7, amount: 2999, tr: "Bulut depolama", en: "Cloud storage" },
    { cat: "subs", acc: "bank", day: 11, amount: 19999, tr: "Dizi platformu", en: "Streaming service" },
    { cat: "subs", acc: "bank", day: 14, amount: 6999, tr: "Müzik aboneliği", en: "Music subscription" },
    { cat: "subs", acc: "bank", day: 17, amount: 8999, tr: "Video aboneliği", en: "Video subscription" },
    { cat: "subs", acc: "bank", day: 20, amount: 5999, tr: "Oyun aboneliği", en: "Game subscription" },

    /* groceries — 648.000 against a 600.000 limit. The weekly shops go on the
       card and the small ones out of the wallet, which is how both accounts end
       the month somewhere a reader recognises. */
    { cat: "groceries", acc: "card", dow: 6, week: 0, day: 5, amount: 124890, tr: "A101 haftalık alışveriş", en: "Weekly shop" },
    { cat: "groceries", acc: "card", dow: 6, week: 1, day: 12, amount: 103750, tr: "BİM haftalık alışveriş", en: "Weekly shop" },
    { cat: "groceries", acc: "card", dow: 6, week: 2, day: 19, amount: 85900, tr: "Zincir market alışverişi", en: "Supermarket run" },
    { cat: "groceries", acc: "cash", dow: 0, week: 1, day: 13, amount: 96430, tr: "Pazar, sebze meyve", en: "Market stall, produce" },
    { cat: "groceries", day: 1, amount: 24890, tr: "Market, ara alışveriş", en: "Corner shop top-up" },
    { cat: "groceries", acc: "cash", day: 2, amount: 18750, tr: "Ekmek ve süt", en: "Bread and milk" },
    { cat: "groceries", acc: "cash", day: 4, amount: 31200, tr: "Kasap, tavuk", en: "Butcher, chicken" },
    { cat: "groceries", acc: "card", day: 6, amount: 42300, tr: "Bakliyat ve kuruyemiş", en: "Pulses and nuts" },
    { cat: "groceries", acc: "cash", day: 8, amount: 29600, tr: "Market, ara alışveriş", en: "Corner shop top-up" },
    { cat: "groceries", acc: "cash", day: 9, amount: 15690, tr: "Fırın", en: "Bakery" },
    { cat: "groceries", acc: "cash", day: 11, amount: 12600, tr: "Yumurta ve peynir", en: "Eggs and cheese" },
    { cat: "groceries", acc: "cash", day: 13, amount: 8760, tr: "Ekmek", en: "Bread" },
    { cat: "groceries", acc: "cash", day: 15, amount: 6540, tr: "Damacana su", en: "Water bottles" },
    { cat: "groceries", acc: "cash", day: 18, amount: 11700, tr: "Kahvaltılık", en: "Breakfast things" },
    { cat: "groceries", acc: "cash", day: 21, amount: 21400, tr: "Manav", en: "Greengrocer" },
    { cat: "groceries", acc: "card", day: 24, amount: 13600, tr: "Şarküteri", en: "Deli counter" },

    /* eating out — 225.500 against a 250.000 limit (90%) */
    { cat: "eatingOut", acc: "card", dow: 6, week: 0, day: 5, amount: 48900, tr: "Akşam yemeği, iki kişi", en: "Dinner for two" },
    { cat: "eatingOut", acc: "card", dow: 6, week: 2, day: 19, amount: 38200, tr: "Akşam yemeği", en: "Dinner out" },
    { cat: "eatingOut", acc: "card", dow: 5, week: 1, day: 11, amount: 22400, tr: "Pide, akşam", en: "Flatbread, evening" },
    { cat: "eatingOut", acc: "cash", day: 2, amount: 18600, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", day: 5, amount: 16500, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", acc: "cash", day: 8, amount: 14750, tr: "Öğle yemeği", en: "Lunch" },
    { cat: "eatingOut", acc: "cash", day: 12, amount: 12300, tr: "Döner, öğle", en: "Kebab, lunch" },
    { cat: "eatingOut", acc: "card", day: 16, amount: 10750, tr: "Kahve ve tatlı", en: "Coffee and cake" },
    { cat: "eatingOut", acc: "cash", day: 19, amount: 10200, tr: "Filtre kahve", en: "Filter coffee" },
    { cat: "eatingOut", acc: "cash", day: 22, amount: 9800, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", acc: "cash", day: 25, amount: 8900, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", acc: "cash", day: 27, amount: 7400, tr: "Kahve", en: "Coffee" },
    { cat: "eatingOut", acc: "cash", day: 29, amount: 6800, tr: "Kahve", en: "Coffee" },

    /* transport — 98.000 of 150.000 */
    { cat: "transport", acc: "card", day: 1, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", acc: "card", day: 7, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", acc: "card", day: 13, amount: 20000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", acc: "cash", dow: 6, week: 3, day: 26, amount: 10500, tr: "Taksi, gece", en: "Taxi, late" },
    { cat: "transport", acc: "cash", day: 10, amount: 9500, tr: "Otobüs kart yükleme", en: "Bus card top-up" },
    { cat: "transport", acc: "card", day: 19, amount: 10000, tr: "Metro kart yükleme", en: "Transit card top-up" },
    { cat: "transport", acc: "cash", day: 16, amount: 4500, tr: "Dolmuş", en: "Shared minibus" },
    { cat: "transport", acc: "cash", day: 23, amount: 3500, tr: "Dolmuş", en: "Shared minibus" },

    /* health, home, fun */
    { cat: "health", acc: "card", day: 6, amount: 18450, tr: "Eczane, vitamin", en: "Pharmacy, vitamins" },
    { cat: "health", acc: "cash", day: 17, amount: 8050, tr: "Eczane, ağrı kesici", en: "Pharmacy, painkillers" },
    { cat: "health", acc: "cash", day: 26, amount: 4500, tr: "Eczane, bant", en: "Pharmacy, plasters" },
    { cat: "home", acc: "card", day: 4, amount: 24900, tr: "Temizlik malzemesi", en: "Cleaning supplies" },
    { cat: "home", acc: "card", day: 12, amount: 18600, tr: "Hırdavat, ampul", en: "Hardware, bulbs" },
    { cat: "home", acc: "card", day: 20, amount: 15500, tr: "Nevresim takımı", en: "Bed linen" },
    { cat: "home", acc: "cash", day: 28, amount: 8000, tr: "Çöp poşeti ve deterjan", en: "Bin bags and detergent" },
    { cat: "fun", acc: "card", dow: 0, week: 2, day: 20, amount: 16000, tr: "Sinema, iki bilet", en: "Cinema, two tickets" },
    { cat: "fun", acc: "card", day: 9, amount: 13500, tr: "Kitap", en: "Book" },
    { cat: "fun", acc: "card", dow: 6, week: 3, day: 26, amount: 8500, tr: "Konser bileti", en: "Concert ticket" },
    { cat: "fun", acc: "cash", day: 22, amount: 4000, tr: "Dergi", en: "Magazine" },

    /* income. The freelance payment goes to savings rather than to the current
       account, so one account on the screen only ever takes money in. */
    { cat: "salary", acc: "bank", day: 0, direction: "in", amount: 4200000, tr: "Maaş", en: "Monthly salary" },
    { cat: "side", acc: "savings", day: 17, direction: "in", amount: 850000, tr: "Serbest iş ödemesi", en: "Freelance invoice" }
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

  /* Six holdings over six kinds, priced on one shared grid of seven dates: the
     first day of each of the last six periods, then the most recent day the
     sample reaches. Sharing the dates is what gives investmentSeries a line
     with seven real points instead of forty-two one-holding steps.

     `prices` is one entry per grid slot in minor units per unit, and a null
     means the holding had not been bought yet — a holding with no price counts
     as nothing in the series, so the line genuinely climbs as the crypto and
     the land share appear. Quantities are stored integers with four implied
     decimals (§3.3): the human figure is in the comment beside each one,
     because dividing by ten thousand in your head is not reading.

     The crypto is DOWN on what it cost, roughly twelve per cent. Every number
     in a demo rising together is the one shape a reader cannot trust, and the
     loss case has its own colour and its own sign on screen. */
  var HOLDINGS = [
    {
      key: "shares", kind: "stock", tone: 0,
      quantity: 1500000,                 /* 150 shares */
      cost: 28750,
      prices: [28750, 29400, 27980, 30650, 32100, 33450, 34280],
      tr: "Havayolu hissesi", en: "Airline shares",
      noteTr: "Aracı kurum hesabında, temettü yeniden yatırılmıyor.",
      noteEn: "Held at a broker; dividends are not reinvested."
    },
    {
      key: "fund", kind: "fund", tone: 1,
      quantity: 12000000,                /* 1.200 units */
      cost: 2150,
      prices: [2150, 2192, 2240, 2218, 2305, 2362, 2404],
      tr: "Hisse senedi fonu", en: "Equity fund",
      noteTr: "Her ayın başında otomatik alım.",
      noteEn: "Bought automatically at the start of each month."
    },
    {
      key: "gold", kind: "gold", tone: 3,
      quantity: 250000,                  /* 25 grams */
      cost: 428000,
      prices: [428000, 441500, 436000, 468000, 489500, 502000, 514000],
      tr: "Gram altın", en: "Gold, by the gram",
      noteTr: "Kasada, gram fiyatı kuyumcudan.",
      noteEn: "Kept at home; the gram price comes from the jeweller."
    },
    {
      key: "crypto", kind: "crypto", tone: 4,
      quantity: 150,                     /* 0,015 BTC */
      cost: 325000000,
      prices: [null, null, 325000000, 341000000, 308500000, 294000000, 287000000],
      tr: "Bitcoin", en: "Bitcoin",
      noteTr: "Üç ay önce alındı, maliyetin altında.",
      noteEn: "Bought three months ago; below what it cost."
    },
    {
      key: "fx", kind: "fx", tone: 5,
      quantity: 8000000,                 /* 800 dollars */
      cost: 4180,
      prices: [4180, 4245, 4318, 4402, 4490, 4568, 4635],
      tr: "Dolar mevduatı", en: "Dollar deposit",
      noteTr: "Vadesiz döviz hesabı.",
      noteEn: "A current account in dollars."
    },
    {
      key: "land", kind: "property", tone: 7,
      quantity: 10000,                   /* one share */
      cost: 8800000,
      /* Land is not repriced every month, so three points is the honest
         history — and it exercises the gap a holding with sparse prices leaves
         in the series, which the dense rows would otherwise hide. */
      prices: [8800000, null, null, 9150000, null, null, 9600000],
      tr: "Arsa payı", en: "Plot share",
      noteTr: "Hisseli tapu, fiyat emsal satışlardan.",
      noteEn: "A share of one title deed; the price comes from nearby sales."
    }
  ];

  /* ---------------------------------------------------------------- helpers */

  var MARK = "_sample_";

  function isSampleRecord(record) {
    if (!record) return false;
    if (record.source === "sample") return true;
    /* Editing a sample row makes it the reader's own: Model stamps a different
       source on it. Once that has happened the id it was born with no longer
       decides, or clearing the sample month would take their own limit and
       their own savings contribution away with it. */
    if (record.source) return false;
    return String(record.id || "").indexOf(MARK) === 1;
  }

  function catId(key) { return "c" + MARK + key; }
  function accId(key) { return "a" + MARK + key; }
  function invId(key) { return "i" + MARK + key; }

  /* Appearance is dealt from the store's own tables rather than written out
     here, because the store is what enforces them: a hex typed into this file
     could drift from the ten colours the stylesheet exposes as --cat-1 …
     --cat-10, and an icon typed here could drift from the one the editor offers
     for that kind. Null when the store is not loaded — the field is then left
     off the record entirely and filled on the next read, which is better than
     writing a colour nothing else in the app agrees with. */
  function spectrum(index) {
    var st = store();
    var list = st && Array.isArray(st.CATEGORY_SPECTRUM) ? st.CATEGORY_SPECTRUM : null;
    if (!list || !list.length) return null;
    return list[index % list.length] || null;
  }

  function iconFor(table, kind) {
    var st = store();
    var map = st ? st[table] : null;
    return (map && map[kind]) || null;
  }

  /* Writes `field` onto `record` only when there is something to write, so a
     missing store leaves the record for fillAccount/fillInvestment to complete
     instead of planting a null the views would read as a colour. */
  function appearance(record, tone, icon) {
    var color = spectrum(tone);
    if (color) record.color = color;
    if (icon) record.icon = icon;
    return record;
  }

  /* The sample ships nine category names a fresh install already has (Kira,
     Market, Maaş…). Shown plain, every category picker in the app then lists
     the same word twice with nothing to tell the two apart, and the reader can
     put their limit on the wrong one — which is the opposite of the strip's
     promise that the sample does not mix with their own records.
     The sample keeps its own categories (clear() has to be able to take them
     back, and borrowing the reader's would park sample spending inside their
     budget rows), so the name carries the mark instead. The label is interface
     copy and comes from the catalog; until the key is there the plain name is
     used rather than printing a key on screen. */
  var SAMPLE_NAME_KEY = "sample.catName";

  function sampleName(plain) {
    var i18n = Moon.I18n;
    if (!i18n || typeof i18n.t !== "function") return plain;
    if (typeof i18n.has === "function" && !i18n.has(SAMPLE_NAME_KEY)) return plain;
    var marked = i18n.t(SAMPLE_NAME_KEY, { name: plain });
    /* t() hands back the key itself when the chain cannot answer it. */
    return marked && marked !== SAMPLE_NAME_KEY ? marked : plain;
  }

  function dayOfWeek(date) {
    var d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
    return d.getDay();
  }

  /* Returns null for an entry the period has not reached yet. Squeezing a whole
     month into however many days have elapsed was the old behaviour, and on the
     1st it put all sixty-one entries on one day: one block in the ledger, one
     point on the trail, and a hero reporting eleven thousand lira spent today.
     A month that is one third gone should show one third of the month, at the
     density it was authored with, so the dates stay where they were written. */
  /* What the sample month is written in: whatever the reader is reporting in
     when they switch it on, because that is the money they are being shown. */
  function displayCurrency() {
    try {
      var code = Moon.Store.state.settings.currency;
      if (typeof code === "string" && /^[A-Za-z]{3}$/.test(code)) return code.toUpperCase();
    } catch (error) { /* not booted: the store's own default stands */ }
    return "TRY";
  }

  function pickDate(days, spec) {
    if (!days.length) return null;
    var wanted = spec.day === undefined ? 0 : spec.day;

    if (spec.dow === undefined) {
      return wanted < days.length ? days[wanted] : null;
    }

    var hits = days.filter(function (date) { return dayOfWeek(date) === spec.dow; });
    if (!hits.length) return null;
    var week = spec.week || 0;
    return week < hits.length ? hits[week] : null;
  }

  function periodStart(periodKey, offset) {
    var d = dates();
    if (!d || !d.shiftPeriod || !d.periodRange) return null;
    var range = d.periodRange(d.shiftPeriod(periodKey, offset), 1);
    return range ? range.start : null;
  }

  /* The seven dates HOLDINGS[].prices is indexed by: the first day of each of
     the last six periods, oldest first, then the last day the sample reaches.
     A slot the calendar cannot answer comes back null and the price in it is
     dropped, so a build on a period the shift helper cannot walk still produces
     holdings — with a shorter history rather than with none. */
  var PRICE_SLOTS = 7;

  function priceGrid(periodKey, days) {
    var grid = [];
    for (var back = PRICE_SLOTS - 2; back >= 0; back -= 1) {
      grid.push(periodStart(periodKey, -back));
    }
    grid.push(days.length ? days[days.length - 1] : null);
    return grid;
  }

  /* One price history from a spec's `prices` and the grid above, oldest first
     and one row per date. Two slots can land on the same date — the period
     start IS the last elapsed day on the first of a month — and then the later
     price wins, which is the same rule store.js applies to a file holding two
     rows for one day. */
  function priceHistory(spec, grid) {
    var byDate = Object.create(null);
    var order = [];
    grid.forEach(function (date, slot) {
      var price = spec.prices[slot];
      if (!date || price === null || price === undefined) return;
      if (!Object.prototype.hasOwnProperty.call(byDate, date)) order.push(date);
      byDate[date] = price;
    });
    order.sort();
    return order.map(function (date) {
      return { date: date, unitPrice: byDate[date] };
    });
  }

  function stamp() {
    return new Date().toISOString();
  }

  /* ------------------------------------------------------------------ build */

  function build(periodKey) {
    var out = {
      categories: [], entries: [], limits: [], recurring: [],
      goals: [], debts: [], accounts: [], investments: []
    };
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

    var code = lang();
    var fixedByKey = Object.create(null);

    CATEGORIES.forEach(function (cat) {
      fixedByKey[cat.key] = cat.fixed;
      out.categories.push(appearance({
        id: catId(cat.key),
        name: sampleName(cat[code]),
        kind: cat.kind,
        fixed: cat.fixed,
        archived: false,
        source: "sample"
      }, cat.tone, cat.icon));
    });

    /* The account is created on the first day the sample reaches, not today:
       its entries are dated inside the period, and a balance built from entries
       older than the account they sit in reads as a bug. */
    ACCOUNTS.forEach(function (spec) {
      out.accounts.push(appearance({
        id: accId(spec.key),
        name: sampleName(spec[code]),
        kind: spec.kind,
        opening: spec.opening,
        currency: currency(),
        archived: false,
        createdAt: days[0],
        source: "sample"
      }, spec.tone, iconFor("ICON_BY_ACCOUNT_KIND", spec.kind)));
    });

    var grid = priceGrid(periodKey, days);
    HOLDINGS.forEach(function (spec) {
      var history = priceHistory(spec, grid);
      var newest = history.length ? history[history.length - 1] : null;
      out.investments.push(appearance({
        id: invId(spec.key),
        name: sampleName(spec[code]),
        kind: spec.kind,
        quantity: spec.quantity,
        unitCost: spec.cost,
        /* Both follow the newest row rather than the spec, because that is the
           rule setInvestmentPrice holds the record to: a price and the day it
           was typed are one reading and must not come apart. */
        unitPrice: newest ? newest.unitPrice : spec.cost,
        priceDate: newest ? newest.date : days[0],
        currency: currency(),
        note: code === "en" ? spec.noteEn : spec.noteTr,
        archived: false,
        createdAt: history.length ? history[0].date : days[0],
        history: history,
        source: "sample"
      }, spec.tone, iconFor("ICON_BY_INVESTMENT_KIND", spec.kind)));
    });

    Object.keys(LIMITS).forEach(function (key) {
      out.limits.push({
        id: "l" + MARK + key,
        categoryId: catId(key),
        amount: LIMITS[key],
        currency: displayCurrency(),
        source: "sample"
      });
    });

    var created = stamp();
    ENTRIES.forEach(function (spec, index) {
      var date = pickDate(days, spec);
      if (!date) return;
      out.entries.push({
        id: "e" + MARK + util.pad2(index + 1),
        date: date,
        amount: spec.amount,
        direction: spec.direction === "in" ? "in" : "out",
        categoryId: catId(spec.cat),
        accountId: spec.acc ? accId(spec.acc) : null,
        /* Stamped like any other record. These are written straight into the
           store rather than through Model.addEntry, so nothing else would do
           it, and an unstamped figure is one that can only be relabelled on a
           change of display currency, never converted. */
        currency: displayCurrency(),
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
        var date = pickDate(days, { day: c.day });
        if (!date) return;
        contributions.push({ date: date, amount: c.amount });
        saved += c.amount;
      });
      out.goals.push({
        id: "g" + MARK + spec.key,
        name: spec[code],
        targetAmount: spec.targetAmount,
        currency: displayCurrency(),
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
        currency: displayCurrency(),
        direction: spec.direction,
        date: pickDate(days, { day: spec.day }) || days[0],
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

  /* Same order as the store's own COLLECTIONS, so a reader diffing an export
     against this file finds the two lists in step. clear() walks it to take the
     sample back, so a collection missing from here is a collection the sample
     plants and never removes. */
  var BUCKETS = ["categories", "entries", "limits", "recurring", "goals", "debts",
    "accounts", "investments"];

  function monthStartDay() {
    var st = store();
    if (st && st.state && st.state.settings) {
      var configured = st.state.settings.monthStartDay;
      if (typeof configured === "number" && configured >= 1 && configured <= 28) return configured;
    }
    return 1;
  }


  /* A month of invented spending only reads as a month if there are days to
     spread it over. Opened on the 1st, the whole set lands on one day: the
     ledger is a single block, the trail has one point, and the panel reports
     a day on which the reader spent eleven thousand lira. That is the first
     screen a visitor sees if they arrive at the start of a month.

     So when the current period is still young, the sample is written into the
     previous one, which is complete and reads the way a month should. It is
     declared sample data either way; showing last month is honest, and a
     demo that looks broken teaches nothing. */
  var MIN_DAYS_ELAPSED = 8;

  function currentPeriod() {
    var d = dates();
    if (!d || !d.today || !d.periodKey) return null;
    return d.periodKey(d.today(), monthStartDay());
  }

  function samplePeriod() {
    var d = dates();
    if (!d || !d.today || !d.periodKey) return null;

    var msd = monthStartDay();
    var key = d.periodKey(d.today(), msd);
    if (!key) return null;

    if (typeof d.periodProgress !== "function" || typeof d.shiftPeriod !== "function") return key;
    var progress = d.periodProgress(key, msd, d.today());
    if (!progress || progress.dayIndex >= MIN_DAYS_ELAPSED) return key;

    return d.shiftPeriod(key, -1) || key;
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

    var periodKey = samplePeriod();
    if (!periodKey) return 0;

    var data = build(periodKey);
    if (!data.entries.length) return 0;

    /* When the sample went to last month because this one is only a few days
       old, those few days should not be empty: stepping the period forward has
       to show a running month, not a blank one. Only the entries are taken —
       every other collection, accounts and holdings included, already came from
       the first build, and reusing their ids would collide. The spill entries
       name the same accounts, so the balances cover both months. */
    var running = currentPeriod();
    if (running && running !== periodKey) {
      var spill = build(running);
      spill.entries.forEach(function (entry, i) {
        entry.id = "e" + MARK + "r" + util.pad2(i + 1);
        data.entries.push(entry);
      });
    }

    st.update(function (draft) {
      BUCKETS.forEach(function (name) {
        if (!Array.isArray(draft[name])) draft[name] = [];
        data[name].forEach(function (record) { draft[name].push(record); });
      });
      if (!draft.settings) draft.settings = {};
      draft.settings.sampleOn = true;
    }, { reason: "sample:apply", immediate: true });

    /* The sample may have been written into last month (see samplePeriod), and
       a reader who turns it on and lands on an empty current month learns the
       wrong thing about the app. Walk the period selector to the month the
       data is in. Guarded: App boots after this file and may not be there. */
    if (Moon.App && typeof Moon.App.setPeriod === "function") {
      try {
        Moon.App.setPeriod(periodKey);
      } catch (error) { /* a router that cannot move is not worth a failed import */ }
    }

    return data.entries.length;
  }

  function clear() {
    var st = store();
    if (!st || !st.update) return 0;

    var removed = 0;
    st.update(function (draft) {
      /* Which categories are about to go. Everything the sample planted is
         removed, but a record the reader filed under one of them is theirs and
         stays — and a record that stays needs a category that stays, or it
         drops out of the ledger filter, out of every budget row, and out of
         reach of the category list. Model applies the same rule removeCategory
         applies; the records are handed over so an inherited fixed/variable
         flag can follow the move. */
      var gone = Object.create(null);
      (Array.isArray(draft.categories) ? draft.categories : []).forEach(function (row) {
        if (isSampleRecord(row)) gone[row.id] = row;
      });

      /* The same question for accounts, and the answer is the one removeAccount
         gives: the account goes and the entry stays, having only lost the link.
         A reader who filed one of their own entries against a sample account —
         the account pickers offer it while the sample is on — would otherwise be
         left with an entry naming an account that no longer exists, counted in
         every spending total and in no balance. */
      var goneAccounts = Object.create(null);
      (Array.isArray(draft.accounts) ? draft.accounts : []).forEach(function (row) {
        if (isSampleRecord(row)) goneAccounts[row.id] = true;
      });

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

      (Array.isArray(draft.entries) ? draft.entries : []).forEach(function (entry) {
        if (entry && entry.accountId && goneAccounts[entry.accountId]) entry.accountId = null;
      });

      if (Moon.Model && Moon.Model.rehomeOrphans) Moon.Model.rehomeOrphans(draft, gone);

      if (!draft.settings) draft.settings = {};
      draft.settings.sampleOn = false;
    }, { reason: "sample:clear", immediate: true });

    return removed;
  }

  /* ---------------------------------------------------------------- selftest
   * Console-only: Moon.Sample._selftest(). Reads build() and the name marking
   * and nothing else — apply() and clear() write to the live store, so they are
   * deliberately out of reach of a test a reader might run on their own data.
   */
  function selftest() {
    var failed = [];
    var passed = 0;

    function ok(label, condition) {
      if (condition) passed += 1;
      else failed.push(label);
    }

    var d = dates();
    if (!d || !d.today || !d.periodKey) {
      return { passed: 0, failed: ["Moon.Dates missing"] };
    }

    var periodKey = d.periodKey(d.today(), 1);
    var data = build(periodKey);

    ok("builds entries", data.entries.length > 0);
    ok("builds categories", data.categories.length === CATEGORIES.length);
    ok("every category is a sample record", data.categories.every(function (c) {
      return c.source === "sample" && c.id.indexOf("c" + MARK) === 0;
    }));

    /* Every record points at a category this same build produced: nothing in
       the sample may lean on a category the reader happens to own. */
    var own = Object.create(null);
    data.categories.forEach(function (c) { own[c.id] = true; });
    ok("entries stay inside the sample", data.entries.every(function (e) { return own[e.categoryId]; }));
    ok("limits stay inside the sample", data.limits.every(function (l) { return own[l.categoryId]; }));
    ok("rules stay inside the sample", data.recurring.every(function (r) { return own[r.categoryId]; }));

    /* One limit per category: two rows for one category is the shape
       periodSummary and budgetRows read differently. */
    var seen = Object.create(null);
    ok("one limit per category", data.limits.every(function (l) {
      if (seen[l.categoryId]) return false;
      seen[l.categoryId] = true;
      return true;
    }));

    /* ---- the balance sheet ----
       Read from a build of the period apply() would really use, not from the
       one above. samplePeriod() guarantees a week of elapsed days, whereas the
       current period on the 1st legitimately reaches only the two entries dated
       on its first day — and then "some entry carries no account" would be
       measuring the calendar rather than the data. */
    var demo = build(samplePeriod() || periodKey);

    var st0 = store();
    var accountKinds = st0 && Array.isArray(st0.ACCOUNT_KINDS) ? st0.ACCOUNT_KINDS : [];
    var holdingKinds = st0 && Array.isArray(st0.INVESTMENT_KINDS) ? st0.INVESTMENT_KINDS : [];

    ok("builds accounts", demo.accounts.length === ACCOUNTS.length);
    ok("builds holdings", demo.investments.length === HOLDINGS.length);
    ok("every account is a sample record", demo.accounts.every(function (a) {
      return a.source === "sample" && a.id.indexOf("a" + MARK) === 0;
    }));
    ok("every holding is a sample record", demo.investments.every(function (i) {
      return i.source === "sample" && i.id.indexOf("i" + MARK) === 0;
    }));

    /* The same rule the categories follow: an entry may point at an account
       this build produced or at none at all, never at one the reader owns. */
    var ownAccounts = Object.create(null);
    demo.accounts.forEach(function (a) { ownAccounts[a.id] = true; });
    ok("entries stay inside the sample's accounts", demo.entries.every(function (e) {
      return e.accountId === null || ownAccounts[e.accountId] === true;
    }));
    ok("some entry carries no account", demo.entries.some(function (e) {
      return e.accountId === null;
    }));
    ok("the balances actually move", demo.entries.some(function (e) {
      return e.accountId !== null;
    }));

    ok("account kinds are kinds the store knows", demo.accounts.every(function (a) {
      return accountKinds.indexOf(a.kind) !== -1;
    }));
    /* §3.2 allows a negative opening and the net-worth card has to be able to
       draw one, so the demo must contain one. */
    ok("one account opens below zero", demo.accounts.some(function (a) {
      return a.opening < 0;
    }));

    ok("holding kinds are kinds the store knows", demo.investments.every(function (i) {
      return holdingKinds.indexOf(i.kind) !== -1;
    }));
    /* The stacked bar by kind is only worth drawing with several kinds in it. */
    var kindsSeen = Object.create(null);
    demo.investments.forEach(function (i) { kindsSeen[i.kind] = true; });
    ok("holdings spread over several kinds", Object.keys(kindsSeen).length >= 4);

    function isWhole(value) {
      return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
    }

    /* A quantity is an integer with four implied decimals and a price is an
       integer in minor units. A float in either would be a holding of the wrong
       size, which is the one error in this file nobody would notice by eye. */
    ok("quantities and prices are whole numbers", demo.investments.every(function (i) {
      return isWhole(i.quantity) && i.quantity >= 0 &&
        isWhole(i.unitCost) && i.unitCost >= 0 &&
        isWhole(i.unitPrice) && i.unitPrice >= 0;
    }));

    ok("history is oldest first, one row per date", demo.investments.every(function (i) {
      var last = null;
      return i.history.length > 0 && i.history.every(function (point) {
        if (!isWhole(point.unitPrice) || point.unitPrice < 0) return false;
        if (last !== null && point.date <= last) return false;
        last = point.date;
        return true;
      });
    }));

    /* setInvestmentPrice holds the record to this and the views read it, so a
       sample record that disagreed with its own newest row would show one price
       in the list and another in the detail. */
    ok("the price and its date follow the newest row", demo.investments.every(function (i) {
      var newest = i.history[i.history.length - 1];
      return !!newest && i.unitPrice === newest.unitPrice && i.priceDate === newest.date;
    }));

    /* Two prices on two dates is what §5.2 needs before the value trail is
       drawn at all; without it the demo shows the "no chart yet" sentence. */
    var priceDates = Object.create(null);
    demo.investments.forEach(function (i) {
      i.history.forEach(function (point) { priceDates[point.date] = true; });
    });
    ok("the value trail has at least two points", Object.keys(priceDates).length >= 2);

    /* Everything in a demo rising together is the shape a reader cannot trust,
       and the loss has its own colour and sign on screen. */
    ok("one holding is below what it cost", demo.investments.some(function (i) {
      return i.unitPrice < i.unitCost;
    }));

    /* The reader's own category names must not come back a second time with
       nothing to tell the two apart (see sampleName). */
    var live = Object.create(null);
    var st = store();
    (st && st.state && Array.isArray(st.state.categories) ? st.state.categories : [])
      .forEach(function (row) {
        if (row && row.source !== "sample" && String(row.id || "").indexOf(MARK) !== 1) {
          live[util.searchKey(row.name)] = true;
        }
      });
    var collisions = data.categories.filter(function (c) {
      return live[util.searchKey(c.name)];
    });
    var marked = Moon.I18n && typeof Moon.I18n.has === "function" && Moon.I18n.has(SAMPLE_NAME_KEY);
    if (marked) {
      ok("marked names collide with nothing", collisions.length === 0);
      ok("the mark is actually applied", data.categories.every(function (c) {
        return CATEGORIES.every(function (spec) { return spec.tr !== c.name && spec.en !== c.name; });
      }));
      /* An account or a holding picker lists these beside the reader's own, so
         they need the same mark the categories get. */
      ok("accounts and holdings are marked too",
        demo.accounts.concat(demo.investments).every(function (row) {
          return ACCOUNTS.concat(HOLDINGS).every(function (spec) {
            return spec.tr !== row.name && spec.en !== row.name;
          });
        }));
    } else {
      /* Without the catalog key the plain name is used on purpose — a key
         printed on screen would be worse than a repeated word. The collisions
         come back as soon as the key lands, which is what the branch above
         then guards. */
      ok("falls back to the plain name", data.categories.every(function (c) {
        return CATEGORIES.some(function (spec) { return spec.tr === c.name || spec.en === c.name; });
      }));
      if (global.console) {
        global.console.log("Moon.Sample selftest: '" + SAMPLE_NAME_KEY + "' is not in the " +
          "catalog yet, so sample categories still show plain names (" +
          collisions.length + " of them match one of the reader's).");
      }
    }

    /* build() reads the store and writes nothing. */
    var before = st && st.state && Array.isArray(st.state.categories) ? st.state.categories.length : 0;
    build(periodKey);
    ok("build writes nothing",
      (st && st.state && Array.isArray(st.state.categories) ? st.state.categories.length : 0) === before);

    return { passed: passed, failed: failed };
  }

  Moon.Sample = {
    build: build,
    apply: apply,
    clear: clear,
    isOn: isOn,
    period: samplePeriod,
    _selftest: selftest
  };
})(window);
