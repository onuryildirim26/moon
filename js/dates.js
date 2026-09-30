/* Moon — dates.
 *
 * Calendar dates are local civil strings, "YYYY-MM-DD". A Date object is a
 * scratch tool here and is never serialised: toISOString() shifts to UTC and
 * new Date("2026-03-01") reads as UTC, so an entry written at 00:30 in
 * Istanbul would land on the previous day. Only new Date(y, m - 1, d).
 *
 * Loads before i18n (see spec §1): every formatting call takes the language.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var DAY_MS = 86400000;

  /* Period start day is capped at 28 so every month can contain it. */
  var MIN_START_DAY = 1;
  var MAX_START_DAY = 28;

  var MONTH_NAMES = {
    tr: {
      long: ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
        "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
      short: ["Oca", "Şub", "Mar", "Nis", "May", "Haz",
        "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]
    },
    en: {
      long: ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"],
      short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    }
  };

  var WEEKDAY_SHORT = {
    tr: ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  };

  /* One table for every month name a CSV may carry: TR and EN, long and
     short, diacritics folded. Keys are lowercase ASCII. */
  var MONTH_LOOKUP = (function () {
    var map = Object.create(null);

    function put(name, month) {
      map[fold(name)] = month;
    }

    ["tr", "en"].forEach(function (lang) {
      MONTH_NAMES[lang].long.forEach(function (name, i) { put(name, i + 1); });
      MONTH_NAMES[lang].short.forEach(function (name, i) { put(name, i + 1); });
    });
    put("sept", 9);          /* seen in English exports */
    put("agustos", 8);       /* folding already covers these, kept explicit */
    put("eylul", 9);
    return map;
  })();

  /* ---------------------------------------------------------------- utils */

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /* Lowercase for name lookup only. toLocaleLowerCase("tr") would turn
     "APRIL" into "aprıl", so this uses plain lowercasing and then folds the
     Turkish letters (and the combining dot of "İ") down to ASCII. */
  function fold(text) {
    return String(text)
      .toLowerCase()
      .replace(/̇/g, "")
      .replace(/[ıİ]/g, "i")
      .replace(/ş/g, "s")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c")
      .replace(/â/g, "a");
  }

  function isInt(n) {
    return typeof n === "number" && isFinite(n) && Math.floor(n) === n;
  }

  /* Day 0 of the next month is the last day of this one — correct for leap
     years and for 2100, which a "divisible by 4" rule gets wrong. */
  function daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
  }

  function isValidYmd(y, m, d) {
    if (!isInt(y) || !isInt(m) || !isInt(d)) return false;
    if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
    return d <= daysInMonth(y, m);
  }

  function ymd(y, m, d) {
    return y + "-" + pad2(m) + "-" + pad2(d);
  }

  function build(y, m, d) {
    return isValidYmd(y, m, d) ? ymd(y, m, d) : null;
  }

  /* Accepts the civil string the app stores; falls back to the flexible
     parser so one stray "26.09.2026" from a caller does not become NaN. */
  function split(date) {
    if (!date || typeof date !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!m) {
      var repaired = parseFlexible(date);
      if (!repaired) return null;
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(repaired);
    }
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (!isValidYmd(y, mo, d)) return null;
    return { y: y, m: mo, d: d };
  }

  function splitKey(periodKey) {
    if (!periodKey || typeof periodKey !== "string") return null;
    var m = /^(\d{4})-(\d{2})$/.exec(periodKey.trim());
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    if (y < 1000 || y > 9999 || mo < 1 || mo > 12) return null;
    return { y: y, m: mo };
  }

  function keyOf(y, m) {
    return y + "-" + pad2(m);
  }

  function addMonths(y, m, n) {
    var total = y * 12 + (m - 1) + n;
    return { y: Math.floor(total / 12), m: (total % 12 + 12) % 12 + 1 };
  }

  /* Day index in UTC space: the arithmetic is DST-free and the inputs are
     civil dates, so no local clock can shift the difference. */
  function dayNumber(p) {
    return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
  }

  function addDays(date, n) {
    var p = split(date);
    if (!p) return null;
    /* setDate carries months and years and survives DST transitions, which
       adding 86400000 ms does not. */
    var scratch = new Date(p.y, p.m - 1, p.d);
    scratch.setDate(scratch.getDate() + n);
    return ymd(scratch.getFullYear(), scratch.getMonth() + 1, scratch.getDate());
  }

  function startDayOf(monthStartDay) {
    var n = typeof monthStartDay === "number" ? monthStartDay : Number(monthStartDay);
    if (!isFinite(n)) return MIN_START_DAY;
    n = Math.floor(n);
    if (n < MIN_START_DAY) return MIN_START_DAY;
    if (n > MAX_START_DAY) return MAX_START_DAY;
    return n;
  }

  function today() {
    var now = new Date();
    return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /* ----------------------------------------------------------- formatting */

  var formatterCache = Object.create(null);

  function localeFor(lang) {
    if (lang === "tr") return "tr-TR";
    if (lang === "en") return "en-US";
    return lang || "tr-TR";
  }

  function namesFor(lang) {
    return MONTH_NAMES[lang] || MONTH_NAMES.tr;
  }

  function formatter(lang, options, cacheKey) {
    var key = (lang || "tr") + "|" + cacheKey;
    if (formatterCache[key] !== undefined) return formatterCache[key];
    var made = null;
    try {
      if (global.Intl && global.Intl.DateTimeFormat) {
        made = new global.Intl.DateTimeFormat(localeFor(lang), options);
      }
    } catch (e) {
      made = null;
    }
    formatterCache[key] = made;
    return made;
  }

  function withIntl(p, lang, options, cacheKey) {
    var f = formatter(lang, options, cacheKey);
    if (!f) return null;
    try {
      return f.format(new Date(p.y, p.m - 1, p.d));
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------- parseFlexible */

  /* Two-digit years: 00-69 are this century, 70-99 the last one. */
  function expandYear(text) {
    if (text.length === 4) return Number(text);
    if (text.length <= 2) {
      var n = Number(text);
      return n <= 69 ? 2000 + n : 1900 + n;
    }
    return NaN;            /* three digits is not a year we will guess at */
  }

  function parseNamed(text) {
    var tokens = text.replace(/[.,]/g, " ").split(/[\s/-]+/).filter(Boolean);
    var monthIndex = -1;
    var month = null;
    var i;

    for (i = 0; i < tokens.length; i += 1) {
      if (/^\d+$/.test(tokens[i])) continue;
      var found = MONTH_LOOKUP[fold(tokens[i])];
      if (!found) return null;           /* an unknown word, not a date */
      if (month) return null;            /* two month names */
      month = found;
      monthIndex = i;
    }
    if (!month) return null;

    var before = [];
    var after = [];
    for (i = 0; i < tokens.length; i += 1) {
      if (!/^\d+$/.test(tokens[i])) continue;
      if (i < monthIndex) before.push(tokens[i]);
      else after.push(tokens[i]);
    }

    var dayText = null;
    var yearText = null;
    if (before.length === 1 && after.length === 1) {
      dayText = before[0];               /* 26 Eyl 2026 */
      yearText = after[0];
    } else if (before.length === 0 && after.length === 2) {
      dayText = after[0];                /* Sep 26 2026 */
      yearText = after[1];
    } else if (before.length === 2 && after.length === 0) {
      dayText = before[0];
      yearText = before[1];
    } else {
      /* No year in the text: guessing one would silently misfile the entry. */
      return null;
    }

    return build(expandYear(yearText), month, Number(dayText));
  }

  function parseFlexible(text, opts) {
    if (text === null || text === undefined) return null;

    var order = opts && opts.order;
    if (order !== "dmy" && order !== "mdy") order = "auto";

    var s = String(text).replace(/[  ]/g, " ").trim();
    if (!s) return null;

    /* A clock time is not part of a civil date; drop it (also the ISO "T"
       form and a trailing zone offset). */
    s = s.replace(/[T\s]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\.\d+)?\s*(?:[AaPp]\.?[Mm]\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/, "").trim();
    if (!s) return null;

    var m;

    /* Year first: unambiguous in every locale. YYYY-MM-DD, YYYY/MM/DD */
    m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

    /* Compact YYYYMMDD, which some exports use and nothing else looks like. */
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

    /* Anything with a letter must be a month name. */
    if (/[^\d\s./:-]/.test(s)) return parseNamed(s);

    /* DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, D.M.YY and the MDY mirror. */
    m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(s);
    if (m) {
      var a = Number(m[1]);
      var b = Number(m[2]);
      var year = expandYear(m[3]);
      var useDmy;

      if (a > 12 && b > 12) return null;            /* neither can be a month */
      else if (a > 12) useDmy = true;               /* 26/09 — day first */
      else if (b > 12) useDmy = false;              /* 09/26 — month first */
      else useDmy = order !== "mdy";                /* ambiguous: caller, else DMY */

      return useDmy ? build(year, b, a) : build(year, a, b);
    }

    return null;
  }

  /* ------------------------------------------------------------------ API */

  var Dates = {
    today: today,

    /* Which budget period a date belongs to. monthStartDay = 15 means
       15 Sep..14 Oct is period "2026-09": the period is named after the
       month it opens in. This is the only place that rule is written. */
    periodKey: function (date, monthStartDay) {
      var p = split(date);
      if (!p) return null;
      var start = startDayOf(monthStartDay);
      if (p.d >= start) return keyOf(p.y, p.m);
      var prev = addMonths(p.y, p.m, -1);
      return keyOf(prev.y, prev.m);
    },

    periodRange: function (periodKey, monthStartDay) {
      var k = splitKey(periodKey);
      if (!k) return null;
      var start = startDayOf(monthStartDay);
      var from = ymd(k.y, k.m, start);
      var next = addMonths(k.y, k.m, 1);
      var to = addDays(ymd(next.y, next.m, start), -1);
      return {
        start: from,
        end: to,
        days: dayNumber(split(to)) - dayNumber(split(from)) + 1
      };
    },

    /* remainingDays includes today: on the last day of the period it is 1,
       which is what the daily allowance divides by. */
    periodProgress: function (periodKey, monthStartDay, todayDate) {
      var range = Dates.periodRange(periodKey, monthStartDay);
      if (!range) return null;

      /* Normalise before comparing: string comparison is only chronological
         when both sides are "YYYY-MM-DD". */
      var given = split(todayDate);
      var now = given ? ymd(given.y, given.m, given.d) : today();

      if (now < range.start) {
        return {
          dayIndex: 0,
          days: range.days,
          remainingDays: range.days,
          ratio: 0,
          isLastDay: false,
          isPast: false,
          isFuture: true
        };
      }
      if (now > range.end) {
        return {
          dayIndex: range.days,
          days: range.days,
          remainingDays: 0,
          ratio: 1,
          isLastDay: false,
          isPast: true,
          isFuture: false
        };
      }

      var dayIndex = dayNumber(split(now)) - dayNumber(split(range.start)) + 1;
      return {
        dayIndex: dayIndex,
        days: range.days,
        remainingDays: range.days - dayIndex + 1,
        ratio: dayIndex / range.days,
        isLastDay: dayIndex === range.days,
        isPast: false,
        isFuture: false
      };
    },

    shiftPeriod: function (periodKey, n) {
      var k = splitKey(periodKey);
      if (!k) return null;
      var step = typeof n === "number" ? Math.round(n) : Math.round(Number(n));
      if (!isFinite(step)) step = 0;
      var moved = addMonths(k.y, k.m, step);
      return keyOf(moved.y, moved.m);
    },

    /* Inclusive on both ends. The cap is a guard against a swapped or
       corrupt range walking for millions of iterations. */
    eachDay: function (start, end) {
      var from = split(start);
      var to = split(end);
      if (!from || !to) return [];
      var span = dayNumber(to) - dayNumber(from);
      if (span < 0) return [];
      if (span > 3660) span = 3660;
      var out = [];
      var cursor = ymd(from.y, from.m, from.d);
      var i;
      for (i = 0; i <= span; i += 1) {
        out.push(cursor);
        cursor = addDays(cursor, 1);
      }
      return out;
    },

    /* b - a in whole days. null when either side is not a usable date, so a
       caller cannot mistake bad input for "the same day". */
    daysBetween: function (a, b) {
      var pa = split(a);
      var pb = split(b);
      if (!pa || !pb) return null;
      return dayNumber(pb) - dayNumber(pa);
    },

    isWeekend: function (date) {
      var p = split(date);
      if (!p) return false;
      var day = new Date(p.y, p.m - 1, p.d).getDay();
      return day === 0 || day === 6;
    },

    weekdayShort: function (date, lang) {
      var p = split(date);
      if (!p) return "";
      var viaIntl = withIntl(p, lang, { weekday: "short" }, "wd");
      if (viaIntl) return viaIntl.replace(/\.$/, "");
      var table = WEEKDAY_SHORT[lang] || WEEKDAY_SHORT.tr;
      return table[new Date(p.y, p.m - 1, p.d).getDay()];
    },

    /* style: "short" (26 Eyl) | "long" (26 Eylül 2026) | "numeric" */
    formatDate: function (date, lang, style) {
      var p = split(date);
      if (!p) return "";
      var names = namesFor(lang);
      var kind = (style === "long" || style === "numeric") ? style : "short";
      var options;

      if (kind === "numeric") {
        options = { year: "numeric", month: "2-digit", day: "2-digit" };
      } else if (kind === "long") {
        options = { year: "numeric", month: "long", day: "numeric" };
      } else {
        options = { month: "short", day: "numeric" };
      }

      var viaIntl = withIntl(p, lang, options, kind);
      if (viaIntl) return viaIntl;

      if (kind === "numeric") {
        return lang === "en"
          ? pad2(p.m) + "/" + pad2(p.d) + "/" + p.y
          : pad2(p.d) + "." + pad2(p.m) + "." + p.y;
      }
      if (kind === "long") {
        return lang === "en"
          ? names.long[p.m - 1] + " " + p.d + ", " + p.y
          : p.d + " " + names.long[p.m - 1] + " " + p.y;
      }
      return lang === "en"
        ? names.short[p.m - 1] + " " + p.d
        : p.d + " " + names.short[p.m - 1];
    },

    formatPeriod: function (periodKey, lang) {
      var k = splitKey(periodKey);
      if (!k) return "";
      var viaIntl = withIntl({ y: k.y, m: k.m, d: 1 }, lang,
        { year: "numeric", month: "long" }, "period");
      if (viaIntl) return viaIntl;
      return namesFor(lang).long[k.m - 1] + " " + k.y;
    },

    parseFlexible: parseFlexible,

    /* Reads a whole column: one value with a first field above 12 settles
       DMY, one with a second field above 12 settles MDY. No evidence (every
       day <= 12) stays null so the wizard can ask instead of guessing. */
    guessOrder: function (samples) {
      if (!samples || typeof samples.length !== "number") return null;
      var dmy = 0;
      var mdy = 0;
      var i;
      for (i = 0; i < samples.length; i += 1) {
        var value = samples[i];
        if (value === null || value === undefined) continue;
        var s = String(value).trim();
        if (/^\d{4}/.test(s)) continue;        /* year first: no evidence */
        var m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/.exec(s);
        if (!m) continue;
        var a = Number(m[1]);
        var b = Number(m[2]);
        if (a > 12 && b <= 12) dmy += 1;
        else if (b > 12 && a <= 12) mdy += 1;
      }
      if (dmy > mdy) return "dmy";
      if (mdy > dmy) return "mdy";
      return null;                             /* none, or contradictory */
    },

    /* ------------------------------------------------------------ selftest
     * Console-only: Moon.Dates._selftest(). Never called in production.
     */
    _selftest: function () {
      var failed = [];
      var passed = 0;

      function eq(label, actual, expected) {
        if (actual === expected) {
          passed += 1;
        } else {
          failed.push(label + ": expected " + JSON.stringify(expected) +
            ", got " + JSON.stringify(actual));
        }
      }

      function ok(label, condition) {
        if (condition) passed += 1;
        else failed.push(label + ": condition failed");
      }

      function pf(input, expected, opts) {
        eq("parseFlexible(" + JSON.stringify(input) +
          (opts ? "," + JSON.stringify(opts) : "") + ")",
          parseFlexible(input, opts), expected);
      }

      ok("today shape", /^\d{4}-\d{2}-\d{2}$/.test(today()));

      eq("periodKey day 1", Dates.periodKey("2026-09-30", 1), "2026-09");
      eq("periodKey msd 15 before", Dates.periodKey("2026-09-14", 15), "2026-08");
      eq("periodKey msd 15 on", Dates.periodKey("2026-09-15", 15), "2026-09");
      eq("periodKey msd 15 after", Dates.periodKey("2026-10-14", 15), "2026-09");
      eq("periodKey january rollback", Dates.periodKey("2026-01-05", 15), "2025-12");
      eq("periodKey clamps msd", Dates.periodKey("2026-09-30", 99), "2026-09");
      eq("periodKey bad date", Dates.periodKey("nope", 1), null);

      var r1 = Dates.periodRange("2026-09", 1);
      eq("periodRange start", r1.start, "2026-09-01");
      eq("periodRange end", r1.end, "2026-09-30");
      eq("periodRange days", r1.days, 30);

      var r2 = Dates.periodRange("2026-09", 15);
      eq("periodRange 15 start", r2.start, "2026-09-15");
      eq("periodRange 15 end", r2.end, "2026-10-14");
      eq("periodRange 15 days", r2.days, 30);

      var r3 = Dates.periodRange("2024-02", 1);
      eq("periodRange leap end", r3.end, "2024-02-29");
      eq("periodRange leap days", r3.days, 29);
      eq("periodRange bad key", Dates.periodRange("2026-13", 1), null);

      var p1 = Dates.periodProgress("2026-09", 1, "2026-09-21");
      eq("progress dayIndex", p1.dayIndex, 21);
      eq("progress days", p1.days, 30);
      eq("progress remainingDays", p1.remainingDays, 10);
      eq("progress ratio", Math.round(p1.ratio * 100) / 100, 0.7);
      eq("progress isLastDay", p1.isLastDay, false);
      eq("progress isPast", p1.isPast, false);
      eq("progress isFuture", p1.isFuture, false);

      var p2 = Dates.periodProgress("2026-09", 1, "2026-09-30");
      eq("progress last day index", p2.dayIndex, 30);
      eq("progress last day remaining", p2.remainingDays, 1);
      eq("progress last day flag", p2.isLastDay, true);

      var p3 = Dates.periodProgress("2026-09", 1, "2026-10-05");
      eq("progress past dayIndex", p3.dayIndex, 30);
      eq("progress past remaining", p3.remainingDays, 0);
      eq("progress past flag", p3.isPast, true);
      eq("progress past ratio", p3.ratio, 1);

      var p4 = Dates.periodProgress("2026-10", 1, "2026-09-30");
      eq("progress future dayIndex", p4.dayIndex, 0);
      eq("progress future remaining", p4.remainingDays, 31);
      eq("progress future flag", p4.isFuture, true);
      eq("progress future ratio", p4.ratio, 0);

      var p5 = Dates.periodProgress("2026-09", 15, "2026-10-14");
      eq("progress msd15 lastDay", p5.isLastDay, true);
      eq("progress msd15 dayIndex", p5.dayIndex, 30);
      var p6 = Dates.periodProgress("2026-09", 15, "2026-09-15");
      eq("progress msd15 firstDay", p6.dayIndex, 1);
      eq("progress msd15 remaining", p6.remainingDays, 30);

      eq("shiftPeriod +1", Dates.shiftPeriod("2026-12", 1), "2027-01");
      eq("shiftPeriod -1", Dates.shiftPeriod("2026-01", -1), "2025-12");
      eq("shiftPeriod -13", Dates.shiftPeriod("2026-01", -13), "2024-12");
      eq("shiftPeriod bad", Dates.shiftPeriod("x", 1), null);

      var days = Dates.eachDay("2026-09-28", "2026-10-01");
      eq("eachDay length", days.length, 4);
      eq("eachDay first", days[0], "2026-09-28");
      eq("eachDay last", days[3], "2026-10-01");
      eq("eachDay reversed", Dates.eachDay("2026-10-01", "2026-09-28").length, 0);
      eq("eachDay single", Dates.eachDay("2026-09-28", "2026-09-28").length, 1);
      eq("eachDay bad", Dates.eachDay(null, "2026-09-28").length, 0);

      eq("daysBetween month", Dates.daysBetween("2026-09-01", "2026-09-30"), 29);
      eq("daysBetween leap", Dates.daysBetween("2024-02-28", "2024-03-01"), 2);
      eq("daysBetween non-leap", Dates.daysBetween("2026-02-28", "2026-03-01"), 1);
      eq("daysBetween backwards", Dates.daysBetween("2026-09-30", "2026-09-01"), -29);
      eq("daysBetween bad", Dates.daysBetween("2026-09-30", "oops"), null);

      eq("isWeekend saturday", Dates.isWeekend("2026-09-26"), true);
      eq("isWeekend sunday", Dates.isWeekend("2026-09-27"), true);
      eq("isWeekend monday", Dates.isWeekend("2026-09-28"), false);
      eq("isWeekend bad", Dates.isWeekend(""), false);

      ok("weekdayShort tr", Dates.weekdayShort("2026-09-26", "tr").length >= 3);
      ok("weekdayShort differs by day",
        Dates.weekdayShort("2026-09-26", "en") !== Dates.weekdayShort("2026-09-28", "en"));
      eq("weekdayShort bad", Dates.weekdayShort("nope", "tr"), "");

      ok("formatPeriod tr", Dates.formatPeriod("2026-09", "tr").indexOf("2026") !== -1);
      ok("formatPeriod tr month", fold(Dates.formatPeriod("2026-09", "tr")).indexOf("eyl") === 0);
      ok("formatPeriod en", Dates.formatPeriod("2026-09", "en").indexOf("September") === 0);
      eq("formatPeriod bad", Dates.formatPeriod("2026", "tr"), "");

      ok("formatDate short tr", Dates.formatDate("2026-09-26", "tr", "short").indexOf("26") !== -1);
      ok("formatDate long tr", Dates.formatDate("2026-09-26", "tr", "long").indexOf("2026") !== -1);
      ok("formatDate numeric tr", /26/.test(Dates.formatDate("2026-09-26", "tr", "numeric")));
      eq("formatDate bad", Dates.formatDate("x", "tr", "short"), "");

      pf("2026-09-26", "2026-09-26");
      pf("2026/09/26", "2026-09-26");
      pf("26.09.2026", "2026-09-26");
      pf("26/09/2026", "2026-09-26", { order: "dmy" });
      pf("26-09-2026", "2026-09-26");
      pf("09/26/2026", "2026-09-26");                 /* second field > 12 */
      pf("03/04/2026", "2026-04-03", { order: "dmy" });
      pf("03/04/2026", "2026-03-04", { order: "mdy" });
      pf("03/04/2026", "2026-04-03");                 /* auto falls back to DMY */
      pf("3.4.26", "2026-04-03", { order: "dmy" });
      pf("01.01.69", "2069-01-01");
      pf("01.01.70", "1970-01-01");
      pf("26 Eyl 2026", "2026-09-26");
      pf("26 Eylül 2026", "2026-09-26");
      pf("1 Ocak 2026", "2026-01-01");
      pf("5 ARALIK 2026", "2026-12-05");
      pf("26 Sep 2026", "2026-09-26");
      pf("26 September 2026", "2026-09-26");
      pf("December 5, 2026", "2026-12-05");
      pf("Sept 5 2026", "2026-09-05");
      pf("26-Eyl-2026", "2026-09-26");
      pf("20260926", "2026-09-26");
      pf("2026-09-26T14:30:00Z", "2026-09-26");
      pf("26.09.2026 14:30", "2026-09-26");
      pf("26.09.2026 14:30:59", "2026-09-26");
      pf("31.02.2026", null);                          /* no such calendar day */
      pf("29.02.2024", "2024-02-29");
      pf("29.02.2026", null);
      pf("13/13/2026", null);
      pf("00.09.2026", null);
      pf("", null);
      pf("abc", null);
      pf("26 Xyz 2026", null);
      pf("26 Eyl", null);                              /* no year: never guessed */
      pf(null, null);

      eq("guessOrder dmy", Dates.guessOrder(["01/02/2026", "13/04/2026"]), "dmy");
      eq("guessOrder mdy", Dates.guessOrder(["01/02/2026", "04/13/2026"]), "mdy");
      eq("guessOrder ambiguous", Dates.guessOrder(["01/02/2026", "03/04/2026"]), null);
      eq("guessOrder empty", Dates.guessOrder([]), null);
      eq("guessOrder junk", Dates.guessOrder(null), null);
      eq("guessOrder iso only", Dates.guessOrder(["2026-09-26", "2026-10-01"]), null);
      eq("guessOrder majority", Dates.guessOrder(["25.09.2026", "26.09.2026", "09/26/2026"]), "dmy");

      return { passed: passed, failed: failed };
    }
  };

  Moon.Dates = Dates;
})(window);
