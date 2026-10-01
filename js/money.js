/* Moon — money.
 *
 * Every amount in the app is an integer count of minor units (kuruş). Text
 * becomes that integer by walking the digits of the string: no parseFloat and
 * no "* 100", because 19.99 * 100 is 1998.9999999999998 and that error
 * survives into a budget threshold comparison.
 *
 * Loads before i18n (see spec §1), so nothing here reads the active language:
 * every formatting call takes opts.lang and defaults to "tr".
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  /* The schema stores amounts in kuruş; the whole app assumes 2 minor digits.
     Multi-currency conversion is deliberately out of scope, so one scale is
     enough and keeping it constant is what makes parse/format reversible. */
  var MINOR_SCALE = 100;
  var MINOR_DIGITS = 2;

  var MAX_SAFE = 9007199254740991;   /* Number.MAX_SAFE_INTEGER, spelled out */
  var NARROW_NBSP = " ";        /* thin unbreakable gap before "₺" (TR) */
  var INVALID = "money.invalid";

  var SYMBOLS = {
    TRY: "₺",
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥"
  };

  /* Used only when Intl is missing or throws. */
  var FALLBACK_SEPARATORS = {
    tr: { group: ".", dec: "," },
    en: { group: ",", dec: "." }
  };

  /* ---------------------------------------------------------------- utils */

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function isSafeInt(n) {
    return typeof n === "number" && isFinite(n) && Math.floor(n) === n &&
      n <= MAX_SAFE && n >= -MAX_SAFE;
  }

  /* A broken record must not poison a sum with NaN, so anything unusable
     reads as zero and anything out of range is clamped rather than dropped.
     Negative zero is folded onto positive zero on the way in: Math.round(-0.5)
     is -0, and -0 reads as "not negative" to a `< 0` test while still printing
     its sign through String(), which puts a stray minus inside the .m-whole
     column of the amount grid instead of in .m-sign. */
  function toMinor(value) {
    var n = typeof value === "number" ? value : Number(value);
    if (!isFinite(n)) return 0;
    n = Math.round(n);
    if (n > MAX_SAFE) return MAX_SAFE;
    if (n < -MAX_SAFE) return -MAX_SAFE;
    return n === 0 ? 0 : n;
  }

  function occurrences(text, ch) {
    return text.split(ch).length - 1;
  }

  function fail() {
    return { ok: false, error: INVALID };
  }

  /* ------------------------------------------------------------- locale */

  var localeCache = Object.create(null);

  function localeFor(lang) {
    if (lang === "tr") return "tr-TR";
    if (lang === "en") return "en-US";
    return lang || "tr-TR";
  }

  /* Separators come from Intl when it works, from the table when it does not.
     Both are cached: building a formatter per ledger row is measurable. */
  function localeInfo(lang) {
    var key = (lang === "en" || lang === "tr") ? lang : (lang ? String(lang) : "tr");
    if (localeCache[key]) return localeCache[key];

    var table = FALLBACK_SEPARATORS[key] || FALLBACK_SEPARATORS.tr;
    var info = {
      locale: localeFor(key),
      group: table.group,
      dec: table.dec,
      wholeFormatter: null
    };

    try {
      if (global.Intl && global.Intl.NumberFormat) {
        var probe = new global.Intl.NumberFormat(info.locale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1
        });
        if (typeof probe.formatToParts === "function") {
          probe.formatToParts(11111.1).forEach(function (part) {
            if (part.type === "group") info.group = part.value;
            if (part.type === "decimal") info.dec = part.value;
          });
        }
        info.wholeFormatter = new global.Intl.NumberFormat(info.locale, {
          maximumFractionDigits: 0,
          useGrouping: true
        });
      }
    } catch (e) {
      info.wholeFormatter = null;
    }

    localeCache[key] = info;
    return info;
  }

  function groupDigits(digits, groupSep) {
    var head = digits;
    var tail = "";
    while (head.length > 3) {
      tail = groupSep + head.slice(head.length - 3) + tail;
      head = head.slice(0, head.length - 3);
    }
    return head + tail;
  }

  function formatWhole(wholeNumber, info) {
    if (info.wholeFormatter) {
      try {
        return info.wholeFormatter.format(wholeNumber);
      } catch (e) { /* fall through to the hand-rolled path */ }
    }
    return groupDigits(String(wholeNumber), info.group);
  }

  /* --------------------------------------------------------------- parse */

  /* Removes one consistent thousands separator and rejects bad grouping.
     "1.234.567" -> "1234567", "1.2.3" -> null (not a grouping, so not a
     number we are willing to guess at). */
  function stripGroups(whole) {
    if (/^\d+$/.test(whole)) return whole;

    var sepChar = null;
    var i;
    for (i = 0; i < whole.length; i += 1) {
      var ch = whole.charAt(i);
      if (ch >= "0" && ch <= "9") continue;
      if (sepChar && ch !== sepChar) return null;
      sepChar = ch;
    }
    if (!sepChar) return null;

    var groups = whole.split(sepChar);
    if (groups.length < 2) return null;
    if (!/^\d{1,3}$/.test(groups[0])) return null;
    for (i = 1; i < groups.length; i += 1) {
      if (!/^\d{3}$/.test(groups[i])) return null;
    }
    return groups.join("");
  }

  /* Which separator is the decimal point? "auto" reads the shape of the
     value the way a person does; an explicit "," or "." trusts the caller
     (the CSV wizard votes per column and passes the winner down). */
  function decimalSeparator(body, mode) {
    if (mode === "," || mode === ".") {
      return body.indexOf(mode) === -1 ? null : mode;
    }

    var dots = occurrences(body, ".");
    var commas = occurrences(body, ",");

    if (dots && commas) {
      /* Both present: the last one is the decimal point. 1.234,56 / 1,234.56 */
      return body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    }
    if (dots === 1 || commas === 1) {
      var sep = dots === 1 ? "." : ",";
      var after = body.length - body.indexOf(sep) - 1;
      /* Exactly three digits behind a lone separator reads as a thousands
         group ("1.234"); one, two or more than three reads as a decimal. */
      return after === 3 ? null : sep;
    }
    /* No separator, or the same one repeated: all thousands. */
    return null;
  }

  function parse(text, opts) {
    var mode = opts && opts.decimal;
    if (mode !== "," && mode !== ".") mode = "auto";

    if (text === null || text === undefined) return fail();

    /* Spaces (incl. NBSP and the narrow NBSP banks export) are noise here,
       and U+2212 / dashes stand in for the minus sign in some statements. */
    var s = String(text)
      .replace(/[\s      ]/g, "")
      .replace(/[−‒–—]/g, "-");
    if (!s) return fail();

    var negative = false;

    /* Accounting negative: (1.234,56) */
    if (s.indexOf("(") !== -1 || s.indexOf(")") !== -1) {
      negative = true;
      s = s.replace(/[()]/g, "");
    }

    /* Currency marks and unit words go away: "₺1.234,56", "1.234,56 TL".
       Letters-only input ends up empty and is rejected below. */
    s = s.replace(/[^\d.,+-]/g, "");

    var shape = /^([+-]?)([\d.,]*)([+-]?)$/.exec(s);
    if (!shape) return fail();
    if (shape[1] && shape[3]) return fail();          /* two signs */
    if (shape[1] === "-" || shape[3] === "-") negative = true;

    var body = shape[2];
    if (!/\d/.test(body)) return fail();

    var decSep = decimalSeparator(body, mode);
    var whole = body;
    var frac = "";

    if (decSep) {
      if (occurrences(body, decSep) !== 1) return fail();
      var at = body.indexOf(decSep);
      whole = body.slice(0, at);
      frac = body.slice(at + 1);
      if (!/^\d*$/.test(frac)) return fail();
    }

    if (whole === "") whole = "0";
    var wholeDigits = stripGroups(whole);
    if (wholeDigits === null) return fail();

    /* Fraction to exactly two digits, on the string: pad one digit, round
       half away from zero on three or more (same result as Math.round). */
    var cents = 0;
    if (frac.length === 1) {
      cents = Number(frac) * 10;
    } else if (frac.length >= MINOR_DIGITS) {
      cents = Number(frac.slice(0, MINOR_DIGITS));
      if (frac.length > MINOR_DIGITS && Number(frac.charAt(MINOR_DIGITS)) >= 5) cents += 1;
    }

    var carry = 0;
    if (cents >= MINOR_SCALE) {
      cents -= MINOR_SCALE;
      carry = 1;
    }

    var significant = wholeDigits.replace(/^0+/, "");
    if (significant.length > 15) return fail();       /* beyond safe integers */

    var minor = Number(wholeDigits) * MINOR_SCALE + cents + carry * MINOR_SCALE;
    if (!isSafeInt(minor)) return fail();

    return {
      ok: true,
      minor: negative && minor > 0 ? -minor : minor,
      abs: minor,
      negative: negative && minor > 0
    };
  }

  /* --------------------------------------------------------------- parts */

  /* Feeds the three-column amount grid: whole / separator / cents as separate
     spans, so the decimal mark stays pixel-aligned while the cents take dim
     ink instead of a smaller size. */
  function parts(minor, opts) {
    var o = opts || {};
    var info = localeInfo(o.lang);
    var value = toMinor(minor);
    var negative = value < 0;
    var abs = negative ? -value : value;

    var wholeNumber = Math.floor(abs / MINOR_SCALE);
    var centsNumber = abs - wholeNumber * MINOR_SCALE;

    var sign = "";
    if (negative) sign = "-";
    else if (value > 0 && (o.sign === true || o.sign === "+" || o.sign === "always")) sign = "+";

    var currency = o.currency || "TRY";
    var lang = (o.lang === "en") ? "en" : (o.lang || "tr");

    return {
      sign: sign,
      whole: formatWhole(wholeNumber, info),
      sep: info.dec,
      cents: pad2(centsNumber),
      symbol: symbolFor(currency),
      symbolFirst: lang !== "tr"
    };
  }

  /* -------------------------------------------------------------- format */

  function format(minor, opts) {
    var o = opts || {};
    var p = parts(minor, o);
    var number = p.whole + p.sep + p.cents;

    if (o.symbol === false || !p.symbol) return p.sign + number;
    if (p.symbolFirst) return p.sign + p.symbol + number;
    return p.sign + number + NARROW_NBSP + p.symbol;
  }

  function symbolFor(currency) {
    if (!currency) return SYMBOLS.TRY;
    var code = String(currency).toUpperCase();
    /* Unknown code: show the code itself rather than an empty gap. */
    return SYMBOLS[code] || code;
  }

  /* ----------------------------------------------------------- arithmetic */

  Moon.Money = {
    MINOR_SCALE: MINOR_SCALE,
    MINOR_DIGITS: MINOR_DIGITS,

    parse: parse,
    format: format,
    parts: parts,
    symbol: symbolFor,

    /* Integer sum. Accepts a list, an array, or a mix of both. */
    add: function () {
      var total = 0;
      var i;
      var j;
      for (i = 0; i < arguments.length; i += 1) {
        var arg = arguments[i];
        if (arg && typeof arg.length === "number" && typeof arg !== "string") {
          for (j = 0; j < arg.length; j += 1) total += toMinor(arg[j]);
        } else {
          total += toMinor(arg);
        }
      }
      if (total > MAX_SAFE) return MAX_SAFE;
      if (total < -MAX_SAFE) return -MAX_SAFE;
      return total;
    },

    /* Whole percent. A zero denominator has no percentage, so it returns
       null and the caller decides what to print. */
    pct: function (part, whole) {
      var w = toMinor(whole);
      if (w === 0) return null;
      var result = Math.round(toMinor(part) / w * 100);
      if (!isFinite(result)) return null;
      return result === 0 ? 0 : result;      /* never -0 (see toMinor) */
    },

    /* Math.round, not banker's rounding (spec §4). A zero or unusable
       divisor yields 0 so callers can keep doing integer arithmetic. */
    divRound: function (minor, n) {
      var count = typeof n === "number" ? n : Number(n);
      if (!isFinite(count) || count === 0) return 0;
      /* Rounding runs on the quotient, so the guard in toMinor cannot see it:
         Math.round(-0.5) is -0 and that sign leaks into the amount grid. */
      var result = Math.round(toMinor(minor) / count);
      return result === 0 ? 0 : result;
    },

    /* ------------------------------------------------------------ selftest
     * Console-only: Moon.Money._selftest(). Never called in production.
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

      /* Amount strings: expected null means "must be rejected". */
      function pm(input, expected, opts) {
        var label = "parse(" + JSON.stringify(input) +
          (opts ? "," + JSON.stringify(opts) : "") + ")";
        var r = parse(input, opts);
        if (expected === null) {
          eq(label + ".ok", r.ok, false);
          if (!r.ok) eq(label + ".error", r.error, INVALID);
          return;
        }
        eq(label + ".ok", r.ok, true);
        eq(label + ".minor", r.ok ? r.minor : null, expected);
      }

      /* Space classes differ between ICU versions; compare them loosely. */
      function looseEq(label, actual, expected) {
        eq(label, String(actual).replace(/[\s  ]/g, " "), expected);
      }

      pm("1.234,56", 123456);
      pm("1,234.56", 123456);
      pm("1234", 123400);
      pm("-19,9", -1990);
      pm("₺1.234,56", 123456);
      pm("1.234,56 TL", 123456);
      pm("(1.234,56)", -123456);
      pm("0,05", 5);
      pm("1.234", 123400);
      pm("1,234", 123400);
      pm("", null);
      pm("abc", null);
      pm("1.2.3", null);
      pm("12,345", 1234500);
      pm("99,999.99", 9999999);

      /* Extra shapes seen in real statements. */
      pm("1.234.567,89", 123456789);
      pm("1,234,567.89", 123456789);
      pm("1 234,56", 123456);
      pm("₺ 1.234,56", 123456);
      pm("1.234,56-", -123456);
      pm("−5,00", -500);
      pm("0", 0);
      pm("0,00", 0);
      pm(",5", 50);
      pm("19.99", 1999);
      pm("1.2345", 123);          /* more than 3 digits behind: decimal, rounded */
      pm("1.2367", 124);          /* rounds half away from zero */
      pm("-", null);
      pm("--5", null);
      pm("5-5", null);
      pm("1.23,45", null);        /* "1.23" is not a thousands group */
      pm("999999999999999999", null);   /* past MAX_SAFE_INTEGER */

      /* Forced decimal mode. */
      pm("1.234,56", 123456, { decimal: "," });
      pm("1,234.56", 123456, { decimal: "." });
      pm("1.234", 123400, { decimal: "," });
      pm("1,234", 123, { decimal: "," });      /* 1,234 -> 1.23 rounded */
      pm("1,005", 101, { decimal: "," });
      pm("1,999", 200, { decimal: "," });      /* cents carry into the lira */
      pm("1,234.56", null, { decimal: "," });  /* mixed shape, caller said "," */

      /* Numbers are tolerated and read as major units, never multiplied. */
      pm(1234, 123400);
      pm(19.99, 1999);

      /* Sign helpers stay available for the importer. */
      var acc = parse("(1.234,56)");
      eq("parse.abs", acc.abs, 123456);
      eq("parse.negative", acc.negative, true);

      looseEq("format tr", format(123456, { currency: "TRY", lang: "tr" }), "1.234,56 ₺");
      looseEq("format en", format(123456, { currency: "TRY", lang: "en" }), "₺1,234.56");
      looseEq("format tr negative", format(-1990, { currency: "TRY", lang: "tr" }), "-19,90 ₺");
      looseEq("format en negative", format(-1990, { currency: "TRY", lang: "en" }), "-₺19.90");
      looseEq("format usd en", format(5, { currency: "USD", lang: "en" }), "$0.05");
      looseEq("format no symbol", format(123456, { lang: "tr", symbol: false }), "1.234,56");
      looseEq("format plus", format(4200000, { currency: "TRY", lang: "tr", sign: true }), "+42.000,00 ₺");

      var p = parts(123456, { lang: "tr", currency: "TRY" });
      eq("parts.whole", p.whole.replace(/[\s  ]/g, " "), "1.234");
      eq("parts.sep", p.sep, ",");
      eq("parts.cents", p.cents, "56");
      eq("parts.symbol", p.symbol, "₺");
      eq("parts.symbolFirst tr", p.symbolFirst, false);
      eq("parts.symbolFirst en", parts(1, { lang: "en" }).symbolFirst, true);
      eq("parts.sign negative", parts(-1, {}).sign, "-");
      eq("parts.sign zero", parts(0, { sign: true }).sign, "");
      eq("parts.cents pad", parts(5, { lang: "tr" }).cents, "05");
      eq("parts.whole zero", parts(5, { lang: "tr" }).whole, "0");
      eq("parts.broken input", parts(undefined, { lang: "tr" }).whole, "0");

      /* Negative zero prints as zero: no minus anywhere, least of all in the
         whole column (see toMinor). */
      eq("parts.negative zero whole", parts(-0, { lang: "tr" }).whole, "0");
      eq("parts.negative zero sign", parts(-0, { lang: "tr" }).sign, "");
      looseEq("format negative zero", format(-0, { currency: "TRY", lang: "tr" }), "0,00 ₺");
      eq("divRound no negative zero", Object.is(Moon.Money.divRound(-1, 2), -0), false);
      eq("parts of divRound(-1,2)", parts(Moon.Money.divRound(-1, 2), { lang: "tr" }).whole, "0");
      eq("add no negative zero", Object.is(Moon.Money.add(-0, -0), -0), false);

      eq("add", Moon.Money.add(1, 2, 3), 6);
      eq("add empty", Moon.Money.add(), 0);
      eq("add array", Moon.Money.add([1990, 1990], 20), 4000);
      eq("add junk", Moon.Money.add(100, null, undefined, NaN, "50"), 150);

      eq("pct", Moon.Money.pct(50, 200), 25);
      eq("pct round", Moon.Money.pct(2, 3), 67);
      eq("pct zero divisor", Moon.Money.pct(1, 0), null);
      eq("pct over", Moon.Money.pct(118, 100), 118);

      eq("divRound", Moon.Money.divRound(100, 3), 33);
      eq("divRound half", Moon.Money.divRound(101, 2), 51);
      eq("divRound zero", Moon.Money.divRound(100, 0), 0);

      eq("symbol TRY", symbolFor("TRY"), "₺");
      eq("symbol USD", symbolFor("USD"), "$");
      eq("symbol EUR", symbolFor("EUR"), "€");
      eq("symbol GBP", symbolFor("GBP"), "£");
      eq("symbol unknown", symbolFor("XYZ"), "XYZ");

      return { passed: passed, failed: failed };
    }
  };
})(window);
