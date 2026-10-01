/* Moon — domain model (contract 02-sozlesme.md §7).
 *
 * Everything derivable is derived here; nothing computed is ever stored.
 * Reads answer in integer minor units, writes go through Moon.Store.update and
 * this file never touches localStorage.
 *
 * The rule that shapes most of the arithmetic below: the daily allowance is a
 * VARIABLE-pool measure. Fixed payments (rent, bills, subscriptions) leave both
 * sides of the fraction, and goals and debts never enter it at all. Without
 * that, a 18.000 TL rent on the first of the month drives the hero number to
 * zero on day two and then lets it climb back — the product hole the jury
 * flagged as A2/A3.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var util = Moon.util;

  /* Dependencies are resolved at call time, never at load time: the page loads
     money/dates/store before this file, and _selftest() swaps in fixtures. */
  var fixtures = null;

  function dates() { return (fixtures && fixtures.Dates) || Moon.Dates; }
  function money() { return (fixtures && fixtures.Money) || Moon.Money; }
  function store() { return (fixtures && fixtures.Store) || Moon.Store; }

  function t(key, params) {
    var i18n = (fixtures && fixtures.I18n) || Moon.I18n;
    return i18n && i18n.t ? i18n.t(key, params) : key;
  }

  /* --------------------------------------------------- suggestion thresholds

     Both suggestion features (budget template, recurring detection) are
     median-based and both have to be defensible out loud, so every threshold
     they use is named here instead of sitting inline. The UI quotes these
     numbers back to the reader ("seen in 3 periods", "amount varies"), and a
     magic number buried in a loop would drift away from the sentence. */

  var SUGGEST_MAX_PERIODS = 6;          /* never read further back than this */
  var SUGGEST_STEP_SMALL = 1000;        /* 10 currency units, in minor units */
  var SUGGEST_STEP_LARGE = 10000;       /* 100 currency units */
  var SUGGEST_SMALL_CEILING = 50000;    /* under 500 units, round by the small step */
  var SUGGEST_CONFIDENCE_HIGH = 3;      /* periods with spending */
  var SUGGEST_CONFIDENCE_MEDIUM = 2;

  var RECURRING_KEY_CHARS = 16;         /* note prefix that decides "same payment" */
  var RECURRING_MIN_PERIODS = 2;        /* two DIFFERENT periods, never two in one */
  var RECURRING_AMOUNT_PCT = 25;        /* a member may sit 25% off the median */
  var RECURRING_VARIES_PCT = 10;        /* past 10% the amount is called variable */
  var RECURRING_MAX_ROWS = 20;
  var RECURRING_LOOKBACK = 12;          /* periods scanned, ending with the current one */

  var SERIES_MONTHS = 12;               /* default window of the holdings chart */

  /* ----------------------------------------------------------- primitives */

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /* A civil date is valid only if the local calendar agrees with the digits,
     so "2026-02-30" is rejected. new Date(y, m-1, d) never reads UTC. */
  function isDate(value) {
    var parts = DATE_RE.exec(String(value === null || value === undefined ? "" : value));
    if (!parts) return false;
    var y = +parts[1];
    var m = +parts[2];
    var d = +parts[3];
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function int(value) {
    var n = typeof value === "number" ? value : Number(value);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function positiveInt(value) {
    var n = int(value);
    return n > 0 ? n : 0;
  }

  function text(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function state() {
    var s = store();
    return s && s.state ? s.state : null;
  }

  function list(name) {
    var st = state();
    var arr = st ? st[name] : null;
    return Array.isArray(arr) ? arr : [];
  }

  function settings() {
    var st = state();
    return st && st.settings ? st.settings : {};
  }

  function monthStartDay() {
    var day = int(settings().monthStartDay);
    return day >= 1 && day <= 28 ? day : 1;
  }

  function periodRange(periodKey) {
    var d = dates();
    if (!d || !d.periodRange || !periodKey) return null;
    var range = d.periodRange(periodKey, monthStartDay());
    if (!range || !isDate(range.start) || !isDate(range.end)) return null;
    return range;
  }

  function progressOf(periodKey) {
    var d = dates();
    if (!d || !d.periodProgress) return null;
    return d.periodProgress(periodKey, monthStartDay(), d.today());
  }

  function todayDate() {
    var d = dates();
    var value = d && d.today ? d.today() : null;
    return isDate(value) ? value : null;
  }

  function direction(entry) {
    return entry && entry.direction === "in" ? "in" : "out";
  }

  /* Entry-level `fixed` wins over the category's, but only when the record
     actually carries a boolean — a missing field inherits. */
  function isFixed(entry, cats) {
    if (entry && typeof entry.fixed === "boolean") return entry.fixed;
    var cat = cats ? cats[entry && entry.categoryId] : categoryById(entry && entry.categoryId);
    return !!(cat && cat.fixed);
  }

  function pct(part, whole) {
    if (!whole) return null;
    var m = money();
    if (m && m.pct) return m.pct(part, whole);
    return Math.round((part / whole) * 100);
  }

  /* Median, never mean. One 4.000 TL month — a plane ticket, a dentist — drags
     a mean upward and the suggested limit with it, and the reader would spend
     the rest of the year under a ceiling they never asked for. Even counts take
     the midpoint of the two middle values, rounded, so the answer stays an
     integer minor amount. Input is copied before sorting. */
  function median(values) {
    if (!values || !values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var middle = sorted.length >> 1;
    if (sorted.length % 2) return sorted[middle];
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  /* Round UP to a step the reader could have picked themselves.
     Why up: a limit is a ceiling. The median is the typical month, so half the
     months sit above it; rounding down would hand back a figure the data
     already calls too tight, and the first period would open in overrun.
     Why a step at all: "1.847,32 ₺" reads as a measurement the tool took, not
     as a decision the reader made, and nobody edits a number like that — they
     delete it. 100 units is the step people actually say out loud.
     Why two steps: with one 100-unit step a 120 ₺ habit would round to 200 ₺,
     a 66% jump. Under 500 units the step drops to 10 so the suggestion stays
     recognisable as the reader's own spending. */
  function roundUpLimit(minor) {
    if (minor <= 0) return 0;
    var step = minor < SUGGEST_SMALL_CEILING ? SUGGEST_STEP_SMALL : SUGGEST_STEP_LARGE;
    return Math.ceil(minor / step) * step;
  }

  function periodKeyOf(date) {
    var d = dates();
    if (!d || !d.periodKey || !isDate(date)) return null;
    var key = d.periodKey(date, monthStartDay());
    return key ? String(key) : null;
  }

  /* The period the reader is standing in. `opts.period` lets a view ask about
     the period in its own header instead of today's. */
  function currentPeriodKey(opts) {
    var o = opts || {};
    if (o.period) return String(o.period);
    var today = todayDate();
    return today ? periodKeyOf(today) : null;
  }

  /* Complete periods before `currentKey`, oldest first. The period in progress
     is excluded on purpose: nine days of groceries would read as a whole month
     and every suggestion would come out too tight. A period counts as closed
     only once its last day is behind today. */
  function completePeriodsBefore(currentKey, count) {
    var d = dates();
    var out = [];
    if (!d || !d.shiftPeriod || !currentKey) return out;
    var today = todayDate();
    for (var i = 1; i <= count; i += 1) {
      var key = d.shiftPeriod(currentKey, -i);
      var range = periodRange(key);
      if (!range) continue;
      if (today && range.end >= today) continue;
      out.unshift(key);
    }
    return out;
  }

  /* ------------------------------------------------------------- reading */

  function categories(opts) {
    var o = opts || {};
    return list("categories").filter(function (cat) {
      if (!cat || !cat.id) return false;
      if (!o.includeArchived && cat.archived) return false;
      if (o.kind && cat.kind !== o.kind) return false;
      return true;
    });
  }

  function categoryById(id) {
    if (!id) return null;
    var all = list("categories");
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  function categoryMap() {
    var map = Object.create(null);
    list("categories").forEach(function (cat) {
      if (cat && cat.id) map[cat.id] = cat;
    });
    return map;
  }

  function categoryName(id) {
    var cat = categoryById(id);
    var name = cat ? text(cat.name).trim() : "";
    return name || t("common.unclassified");
  }

  function limitFor(categoryId) {
    if (!categoryId) return null;
    var all = list("limits");
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].categoryId === categoryId) {
        var amount = positiveInt(all[i].amount);
        return amount > 0 ? amount : null;
      }
    }
    return null;
  }

  function entries(filter) {
    var f = filter || {};
    var from = f.from && isDate(f.from) ? f.from : null;
    var to = f.to && isDate(f.to) ? f.to : null;
    var periodPrefix = null;

    if (f.period) {
      var range = periodRange(f.period);
      if (range) {
        from = from && from > range.start ? from : range.start;
        to = to && to < range.end ? to : range.end;
      } else {
        /* No Dates module yet: fall back to the calendar month so a filtered
           read never silently widens to the whole ledger. */
        periodPrefix = String(f.period).slice(0, 7);
      }
    }

    var needle = f.search ? util.searchKey(f.search) : "";
    var cats = needle ? categoryMap() : null;

    var picked = list("entries").filter(function (e) {
      if (!e || !e.id || !isDate(e.date)) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      if (periodPrefix && e.date.slice(0, 7) !== periodPrefix) return false;
      if (f.categoryId && e.categoryId !== f.categoryId) return false;
      if (f.direction && direction(e) !== f.direction) return false;
      if (typeof f.confirmed === "boolean" && !!e.confirmed !== f.confirmed) return false;
      if (f.source && e.source !== f.source) return false;
      if (needle) {
        var cat = cats[e.categoryId];
        var hay = util.searchKey(e.note) + util.searchKey(cat ? cat.name : "");
        if (hay.indexOf(needle) === -1) return false;
      }
      return true;
    });

    /* Date desc, then createdAt desc — sortBy is stable, so equal keys keep
       their insertion order. */
    return util.sortBy(picked, function (e) {
      return e.date + "|" + text(e.createdAt);
    }, true);
  }

  /* --------------------------------------------------------- derived reads */

  function periodSummary(periodKey) {
    var cats = categoryMap();
    var rows = entries({ period: periodKey });
    var range = periodRange(periodKey);

    var out = {
      spentTotal: 0,
      spentVariable: 0,
      spentFixed: 0,
      income: 0,
      net: 0,
      limitTotal: 0,
      limitVariable: 0,
      limitFixed: 0,
      entryCount: rows.length,
      fixedCount: 0,
      dayCount: range ? int(range.days) : 0
    };

    rows.forEach(function (e) {
      var amount = positiveInt(e.amount);
      if (!amount) return;
      if (direction(e) === "in") {
        out.income += amount;
        return;
      }
      out.spentTotal += amount;
      if (isFixed(e, cats)) {
        out.spentFixed += amount;
        out.fixedCount += 1;
      } else {
        out.spentVariable += amount;
      }
    });

    list("limits").forEach(function (limit) {
      if (!limit) return;
      var amount = positiveInt(limit.amount);
      if (!amount) return;
      var cat = cats[limit.categoryId];
      if (!cat || cat.archived) return;
      /* An income category has no spending to cap, and budgetRows refuses to
         draw a row for one. Counting its limit here would grow the allowance
         pool by money the reader can never find in the Limits section. */
      if (cat.kind === "income") return;
      out.limitTotal += amount;
      if (cat.fixed) out.limitFixed += amount;
      else out.limitVariable += amount;
    });

    out.net = out.income - out.spentTotal;
    return out;
  }

  /* The hero measurement. Pool and spend are both the variable side only. */
  function dailyAllowance(periodKey) {
    var sum = periodSummary(periodKey);
    var progress = progressOf(periodKey) || {
      dayIndex: 0, days: sum.dayCount, remainingDays: sum.dayCount,
      ratio: 0, isLastDay: false, isPast: false, isFuture: false
    };

    var pool = sum.limitVariable;
    var spent = sum.spentVariable;
    var remaining = pool - spent;
    var remainingDays = int(progress.remainingDays);

    var result = {
      state: "ok",
      perDay: null,
      remainingAmount: remaining,
      remainingDays: remainingDays,
      fixedReserved: sum.spentFixed,
      fixedCount: sum.fixedCount,
      spentToday: 0,
      perDayLeftToday: null,
      spentRatio: pool > 0 ? spent / pool : 0,
      periodRatio: typeof progress.ratio === "number" ? progress.ratio : 0
    };

    /* Today's reading only exists while the period contains today, and it
       counts variable spending so that it subtracts from the same pool. */
    var today = todayDate();
    var range = periodRange(periodKey);
    if (today && range && today >= range.start && today <= range.end) {
      var cats = categoryMap();
      list("entries").forEach(function (e) {
        if (!e || e.date !== today || direction(e) === "in") return;
        if (isFixed(e, cats)) return;
        result.spentToday += positiveInt(e.amount);
      });
    }

    if (pool === 0) {
      result.state = "noLimits";
      return result;
    }
    if (remaining < 0) {
      result.state = "overspent";
      return result;
    }
    if (progress.isLastDay) {
      result.state = "lastDay";
      result.perDay = remaining;
    } else if (progress.isPast) {
      /* A closed period has no day left to divide by; the reading is the
         leftover amount, not a per-day figure. */
      result.state = "pastPeriod";
      result.perDay = null;
      return result;
    } else {
      result.perDay = Math.floor(remaining / (remainingDays > 0 ? remainingDays : 1));
    }

    result.perDayLeftToday = result.perDay === null ? null : result.perDay - result.spentToday;
    return result;
  }

  /* One point per elapsed day, each computed as it stood AT THE END of that
     day: cumulative variable spend so far, divided over the days that were
     still to come. Future days are absent by design. */
  function allowanceTrail(periodKey) {
    var range = periodRange(periodKey);
    var d = dates();
    if (!range || !d || !d.eachDay) return [];

    var sum = periodSummary(periodKey);
    var pool = sum.limitVariable;
    if (pool <= 0) return [];

    var today = todayDate();
    var last = range.end;
    if (today && today < range.start) return [];
    if (today && today < range.end) last = today;

    var days = d.eachDay(range.start, last);
    if (!days || !days.length) return [];

    var total = int(range.days) || days.length;
    var reference = Math.floor(pool / total);
    var cats = categoryMap();
    var perDaySpend = Object.create(null);

    list("entries").forEach(function (e) {
      if (!e || !isDate(e.date) || direction(e) === "in") return;
      if (e.date < range.start || e.date > last) return;
      if (isFixed(e, cats)) return;
      perDaySpend[e.date] = (perDaySpend[e.date] || 0) + positiveInt(e.amount);
    });

    var spent = 0;
    return days.map(function (date, index) {
      spent += perDaySpend[date] || 0;
      var left = total - (index + 1);
      return {
        date: date,
        perDay: Math.floor((pool - spent) / (left > 0 ? left : 1)),
        reference: reference
      };
    });
  }

  function dailyFlow(periodKey) {
    var range = periodRange(periodKey);
    var d = dates();
    if (!range || !d || !d.eachDay) return [];

    var byDate = Object.create(null);
    list("entries").forEach(function (e) {
      if (!e || !isDate(e.date)) return;
      if (e.date < range.start || e.date > range.end) return;
      var bucket = byDate[e.date];
      if (!bucket) {
        bucket = { inAmount: 0, outAmount: 0 };
        byDate[e.date] = bucket;
      }
      if (direction(e) === "in") bucket.inAmount += positiveInt(e.amount);
      else bucket.outAmount += positiveInt(e.amount);
    });

    var days = d.eachDay(range.start, range.end) || [];
    return days.map(function (date) {
      var bucket = byDate[date];
      return {
        date: date,
        inAmount: bucket ? bucket.inAmount : 0,
        outAmount: bucket ? bucket.outAmount : 0,
        weekend: d.isWeekend ? !!d.isWeekend(date) : false
      };
    });
  }

  function cumulativePoints(periodKey, untilDate) {
    var range = periodRange(periodKey);
    var d = dates();
    if (!range || !d || !d.eachDay) return [];

    var last = untilDate && untilDate < range.end ? untilDate : range.end;
    if (last < range.start) return [];

    var byDate = Object.create(null);
    var any = false;
    list("entries").forEach(function (e) {
      if (!e || !isDate(e.date) || direction(e) === "in") return;
      if (e.date < range.start || e.date > last) return;
      byDate[e.date] = (byDate[e.date] || 0) + positiveInt(e.amount);
      any = true;
    });
    if (!any) return [];

    var total = 0;
    return (d.eachDay(range.start, last) || []).map(function (date) {
      total += byDate[date] || 0;
      return { date: date, total: total };
    });
  }

  function cumulative(periodKey) {
    var range = periodRange(periodKey);
    var d = dates();
    var out = { points: [], pace: [], crossedOn: null, ghost: null };
    if (!range || !d || !d.eachDay) return out;

    var today = todayDate();
    out.points = cumulativePoints(periodKey, today);

    var limitTotal = periodSummary(periodKey).limitTotal;
    var days = d.eachDay(range.start, range.end) || [];
    var total = days.length || int(range.days);
    if (limitTotal > 0 && total > 0) {
      out.pace = days.map(function (date, index) {
        return { date: date, total: Math.round((limitTotal * (index + 1)) / total) };
      });
    }

    if (out.pace.length) {
      var paceByDate = Object.create(null);
      out.pace.forEach(function (p) { paceByDate[p.date] = p.total; });
      for (var i = 0; i < out.points.length; i += 1) {
        var target = paceByDate[out.points[i].date];
        if (target !== undefined && out.points[i].total > target) {
          out.crossedOn = out.points[i].date;
          break;
        }
      }
    }

    if (d.shiftPeriod) {
      var previous = cumulativePoints(d.shiftPeriod(periodKey, -1), null);
      out.ghost = previous.length ? previous : null;
    }
    return out;
  }

  function budgetRows(periodKey) {
    var progress = progressOf(periodKey);
    var paceRatio = progress && typeof progress.ratio === "number"
      ? util.clamp(progress.ratio, 0, 1)
      : 0;

    var spentBy = Object.create(null);
    entries({ period: periodKey }).forEach(function (e) {
      if (direction(e) === "in") return;
      var id = e.categoryId || "";
      spentBy[id] = (spentBy[id] || 0) + positiveInt(e.amount);
    });

    var limits = Object.create(null);
    list("limits").forEach(function (limit) {
      if (!limit || !limit.categoryId) return;
      var amount = positiveInt(limit.amount);
      if (amount > 0) limits[limit.categoryId] = amount;
    });

    var rows = [];
    list("categories").forEach(function (cat) {
      if (!cat || !cat.id || cat.kind === "income") return;
      var spent = spentBy[cat.id] || 0;
      var limit = limits[cat.id] || null;
      /* A category earns a row when it has a limit or saw money this period;
         an archived one only when money moved through it. */
      if (limit === null && spent === 0) return;
      if (cat.archived && spent === 0) return;

      var fixed = !!cat.fixed;
      var drift = null;
      var driftState = null;

      if (limit !== null) {
        drift = Math.round(limit * paceRatio) - spent;
        if (spent > limit) driftState = "over";
        else if (fixed && spent >= limit) driftState = "done";
        else if (drift >= 0) driftState = "ahead";
        else driftState = "behind";
      }

      rows.push({
        categoryId: cat.id,
        name: text(cat.name).trim() || t("common.unclassified"),
        fixed: fixed,
        spent: spent,
        limit: limit,
        pct: limit === null ? null : pct(spent, limit),
        paceRatio: paceRatio,
        drift: drift,
        driftState: driftState
      });
    });

    /* Unclassified spending still has to be visible somewhere. */
    var orphan = spentBy[""] || 0;
    if (orphan > 0) {
      rows.push({
        categoryId: null,
        name: t("common.unclassified"),
        fixed: false,
        spent: orphan,
        limit: null,
        pct: null,
        paceRatio: paceRatio,
        drift: null,
        driftState: null
      });
    }

    var variable = util.sortBy(rows.filter(function (r) { return !r.fixed; }), function (r) {
      return r.pct === null ? -1 : r.pct;
    }, true);
    var fixedRows = util.sortBy(rows.filter(function (r) { return r.fixed; }), function (r) {
      return util.lower(r.name);
    });

    /* Variable rows first, worst pct on top — that is the reading order of the
       limit scales. Fixed rows settle underneath by name. */
    return variable.concat(fixedRows);
  }

  function yearGrid(endPeriodKey) {
    var d = dates();
    var out = { periods: [], rows: [] };
    if (!d || !d.shiftPeriod || !endPeriodKey) return out;

    for (var i = 11; i >= 0; i -= 1) {
      out.periods.push(d.shiftPeriod(endPeriodKey, -i));
    }

    var ranges = out.periods.map(function (key) { return periodRange(key); });
    var cats = list("categories").filter(function (cat) {
      return cat && cat.id && cat.kind !== "income";
    });

    cats.forEach(function (cat) {
      var cells = out.periods.map(function (key) {
        return { period: key, amount: 0, density: 0 };
      });
      var touched = false;

      list("entries").forEach(function (e) {
        if (!e || e.categoryId !== cat.id || direction(e) === "in") return;
        if (!isDate(e.date)) return;
        for (var j = 0; j < ranges.length; j += 1) {
          var range = ranges[j];
          if (range && e.date >= range.start && e.date <= range.end) {
            cells[j].amount += positiveInt(e.amount);
            touched = true;
            break;
          }
        }
      });

      if (!touched) return;

      /* Density is read ACROSS the row: each category is scaled to its own
         twelve-month peak, so a small category stays readable next to rent. */
      var peak = 0;
      cells.forEach(function (cell) { if (cell.amount > peak) peak = cell.amount; });
      if (peak > 0) {
        cells.forEach(function (cell) {
          cell.density = cell.amount <= 0
            ? 0
            : util.clamp(Math.ceil((cell.amount / peak) * 4), 1, 4);
        });
      }

      out.rows.push({
        categoryId: cat.id,
        name: text(cat.name).trim() || t("common.unclassified"),
        cells: cells
      });
    });

    return out;
  }

  /* ------------------------------------------------- budget template (1/2) */

  /* "Suggest limits for me", read off the reader's own closed periods.
     The whole feature is one median per category plus a readable rounding step;
     nothing here is a model, a forecast or an average, and the same ledger
     always produces the same suggestion.
     What stays out: the period in progress (half a month suggests half a
     limit), income categories (there is nothing to cap), archived categories
     (periodSummary ignores their limits, so a limit there would be invisible),
     and entries whose category no longer exists (a limit needs something to
     hang from). Fixed categories DO get a row — rent is the easiest limit to
     set correctly — but they are flagged so the UI can say that this one never
     enters the daily-allowance pool. */
  function suggestLimits(opts) {
    var o = opts || {};
    var basis = { periods: [], entryCount: 0, complete: false };
    var out = { basis: basis, rows: [] };

    var current = currentPeriodKey(o);
    if (!current) return out;

    var asked = int(o.maxPeriods);
    var window = asked > 0 ? Math.min(asked, SUGGEST_MAX_PERIODS) : SUGGEST_MAX_PERIODS;
    var candidates = completePeriodsBefore(current, window);
    if (!candidates.length) return out;

    var ranges = Object.create(null);
    candidates.forEach(function (key) { ranges[key] = periodRange(key); });

    var cats = categoryMap();
    var observed = Object.create(null);    /* periodKey -> the ledger reaches here */
    var byCategory = Object.create(null);  /* categoryId -> {periodKey: minor} */
    var order = [];
    var counted = 0;

    list("entries").forEach(function (e) {
      if (!e || !isDate(e.date)) return;
      var key = null;
      for (var i = 0; i < candidates.length; i += 1) {
        var range = ranges[candidates[i]];
        if (range && e.date >= range.start && e.date <= range.end) {
          key = candidates[i];
          break;
        }
      }
      if (!key) return;
      /* Any entry at all proves the reader was keeping the ledger that period,
         so a period with income only still counts as observed — it just leaves
         every expense median alone. */
      observed[key] = true;
      if (direction(e) === "in") return;
      var cat = cats[e.categoryId];
      if (!cat || cat.kind === "income" || cat.archived) return;
      var amount = positiveInt(e.amount);
      if (!amount) return;
      var perPeriod = byCategory[cat.id];
      if (!perPeriod) {
        perPeriod = byCategory[cat.id] = Object.create(null);
        order.push(cat.id);
      }
      perPeriod[key] = (perPeriod[key] || 0) + amount;
      counted += 1;
    });

    basis.periods = candidates.filter(function (key) { return !!observed[key]; });
    basis.entryCount = counted;
    basis.complete = basis.periods.length > 0;
    if (!basis.complete) return out;

    var rows = [];
    order.forEach(function (categoryId) {
      var monthly = [];
      var perPeriod = {};
      basis.periods.forEach(function (key) {
        var amount = byCategory[categoryId][key] || 0;
        perPeriod[key] = amount;
        /* A month with no spending is reported as 0 but kept OUT of the median.
           Counting the empty months would halve the suggestion for anything
           seasonal (clothing, repairs) and the reader would overrun it the
           first time the category comes round again. monthsSeen says how thin
           the evidence is, and `confidence` turns that into one word. */
        if (amount > 0) monthly.push(amount);
      });
      if (!monthly.length) return;

      var suggested = roundUpLimit(median(monthly));
      if (!suggested) return;

      var cat = cats[categoryId];
      if (!cat) return;

      rows.push({
        categoryId: categoryId,
        name: text(cat.name).trim() || t("common.unclassified"),
        fixed: !!cat.fixed,
        suggested: suggested,
        current: limitFor(categoryId),
        monthsSeen: monthly.length,
        perPeriod: perPeriod,
        confidence: monthly.length >= SUGGEST_CONFIDENCE_HIGH
          ? "high"
          : (monthly.length >= SUGGEST_CONFIDENCE_MEDIUM ? "medium" : "low")
      });
    });

    /* Biggest suggestion first — that is where the reader's money is and where
       a limit changes behaviour. Two stable passes give the composite order
       without packing a sort key into a string. */
    rows = util.sortBy(rows, function (row) { return util.lower(row.name); });
    out.rows = util.sortBy(rows, function (row) { return row.suggested; }, true);
    return out;
  }

  /* The day a recurring rule falls on inside one period. The period can span
     two calendar months when monthStartDay > 1, and a day the month does not
     have (31 February) clamps to that month's last day. */
  function occurrenceDate(recurring, periodKey) {
    var range = periodRange(periodKey);
    if (!range || !recurring) return null;

    var wanted = util.clamp(int(recurring.dayOfMonth) || 1, 1, 31);
    var months = [range.start.slice(0, 7)];
    if (range.end.slice(0, 7) !== months[0]) months.push(range.end.slice(0, 7));

    for (var i = 0; i < months.length; i += 1) {
      var year = +months[i].slice(0, 4);
      var month = +months[i].slice(5, 7);
      var day = Math.min(wanted, daysInMonth(year, month));
      var candidate = months[i] + "-" + util.pad2(day);
      if (candidate >= range.start && candidate <= range.end) return candidate;
    }
    return null;
  }

  function recurringDue(recurring, periodKey) {
    if (!recurring || !recurring.active) return null;
    if (recurring.lastGeneratedPeriod && recurring.lastGeneratedPeriod >= periodKey) return null;
    var date = occurrenceDate(recurring, periodKey);
    if (!date) return null;
    if (recurring.startDate && date < recurring.startDate) return null;
    if (recurring.endDate && date > recurring.endDate) return null;
    return date;
  }

  function pendingRecurring(periodKey) {
    var out = [];
    list("recurring").forEach(function (r) {
      var date = recurringDue(r, periodKey);
      if (!date) return;
      out.push({ recurring: r, date: date, amount: positiveInt(r.amount) });
    });
    return util.sortBy(out, function (row) { return row.date; });
  }

  /* ----------------------------------------------- recurring detection (1/2) */

  /* Identity of a repeated payment: same category, same direction, same first
     16 characters of the note's search key. Short enough that "Spotify
     Premium" and "Spotify" land together, long enough that "Migros" and
     "Migros Toptan" do not pretend to be one subscription. */
  function recurringKeyOf(categoryId, dir, noteOrName) {
    var prefix = util.searchKey(noteOrName).slice(0, RECURRING_KEY_CHARS);
    return prefix ? categoryId + "|" + dir + "|" + prefix : null;
  }

  function dayOfMonthOf(date) {
    return isDate(date) ? +String(date).slice(8, 10) : 0;
  }

  /* The note that appears most often, which is what the reader would have
     typed as the rule's name. Ties go to the earliest occurrence so the same
     ledger always names the rule the same way. */
  function commonNote(rows) {
    var counts = Object.create(null);
    var best = null;
    rows.forEach(function (row) {
      var note = text(row.note).trim();
      if (!note) return;
      counts[note] = (counts[note] || 0) + 1;
    });
    rows.forEach(function (row) {
      var note = text(row.note).trim();
      if (!note) return;
      if (!best || counts[note] > counts[best]) best = note;
    });
    return best || "";
  }

  /* Repeated payments the reader has not turned into a rule yet.
     This only reads: it proposes, the UI disposes, and promoteToRecurring is
     the only thing that writes. Income counts too — a salary is the most
     reliably recurring record in any ledger. */
  function detectRecurring(opts) {
    var o = opts || {};
    var d = dates();
    var current = currentPeriodKey(o);
    if (!current || !d || !d.shiftPeriod) return [];

    var asked = int(o.lookback);
    var lookback = asked > 0 ? asked : RECURRING_LOOKBACK;
    var first = periodRange(d.shiftPeriod(current, -(lookback - 1)));
    var last = periodRange(current);
    if (!first || !last) return [];

    var from = first.start;
    var to = last.end;
    var cats = categoryMap();
    var groups = Object.create(null);
    var order = [];

    list("entries").forEach(function (e) {
      if (!e || !e.id || !isDate(e.date)) return;
      if (e.date < from || e.date > to) return;
      var amount = positiveInt(e.amount);
      if (!amount) return;
      /* A rule has to hang from a category that exists, and a record with no
         note has no stable identity — grouping those together would propose
         "a rule for everything you did not describe". */
      var cat = cats[e.categoryId];
      if (!cat) return;
      var key = recurringKeyOf(cat.id, direction(e), e.note);
      if (!key) return;

      var group = groups[key];
      if (!group) {
        group = groups[key] = { key: key, categoryId: cat.id, direction: direction(e), rows: [] };
        order.push(key);
      }
      group.rows.push({
        entryId: e.id,
        date: e.date,
        amount: amount,
        note: text(e.note),
        fixed: isFixed(e, cats),
        recurringId: e.recurringId || null
      });
    });

    var ruleByKey = Object.create(null);
    var ruleById = Object.create(null);
    list("recurring").forEach(function (rule) {
      if (!rule || !rule.id) return;
      ruleById[rule.id] = rule;
      var key = recurringKeyOf(rule.categoryId, rule.direction === "in" ? "in" : "out", rule.name);
      if (key && !ruleByKey[key]) ruleByKey[key] = rule.id;
    });

    var out = [];
    order.forEach(function (key) {
      var group = groups[key];
      var rows = util.sortBy(group.rows, function (row) { return row.date + "|" + row.entryId; });

      /* Two passes over the amounts. The first median decides who belongs: a
         single 900 ₺ grocery run must not pull a 90 ₺ weekly habit apart, so
         anything further than 25% from it is dropped rather than averaged in.
         The second median, over what is left, is the figure reported. */
      var center = median(rows.map(function (row) { return row.amount; }));
      if (!center) return;
      var kept = rows.filter(function (row) {
        return Math.abs(row.amount - center) * 100 <= RECURRING_AMOUNT_PCT * center;
      });
      if (kept.length < RECURRING_MIN_PERIODS) return;

      var amount = median(kept.map(function (row) { return row.amount; }));
      if (!amount) return;

      /* The load-bearing rule: two different periods. Two coffees in one week
         are a week, not a subscription. */
      var periods = [];
      kept.forEach(function (row) {
        var periodKey = periodKeyOf(row.date);
        if (periodKey && periods.indexOf(periodKey) === -1) periods.push(periodKey);
      });
      if (periods.length < RECURRING_MIN_PERIODS) return;
      periods.sort();

      var existingRuleId = null;
      kept.forEach(function (row) {
        if (!existingRuleId && row.recurringId && ruleById[row.recurringId]) {
          existingRuleId = row.recurringId;
        }
      });
      if (!existingRuleId && ruleByKey[key]) existingRuleId = ruleByKey[key];

      out.push({
        key: key,
        name: commonNote(kept),
        categoryId: group.categoryId,
        direction: group.direction,
        amount: amount,
        amountVaries: kept.some(function (row) {
          return Math.abs(row.amount - amount) * 100 > RECURRING_VARIES_PCT * amount;
        }),
        dayOfMonth: util.clamp(median(kept.map(function (row) {
          return dayOfMonthOf(row.date);
        })) || 1, 1, 31),
        occurrences: kept.map(function (row) {
          return { entryId: row.entryId, date: row.date, amount: row.amount };
        }),
        periods: periods,
        existingRuleId: existingRuleId,
        alreadyFixed: kept.every(function (row) { return row.fixed; })
      });
    });

    /* Most periods first: a payment seen in five months is a surer rule than
       one seen in two. Stable passes, least significant first, so the order is
       total and the same ledger always lists them the same way. */
    out = util.sortBy(out, function (row) { return row.key; });
    out = util.sortBy(out, function (row) { return row.amount; }, true);
    out = util.sortBy(out, function (row) { return row.occurrences.length; }, true);
    out = util.sortBy(out, function (row) { return row.periods.length; }, true);
    return out.slice(0, RECURRING_MAX_ROWS);
  }

  function goalSaved(goal) {
    if (!goal) return 0;
    if (typeof goal.savedAmount === "number") return positiveInt(goal.savedAmount);
    var total = 0;
    (Array.isArray(goal.contributions) ? goal.contributions : []).forEach(function (c) {
      total += positiveInt(c && c.amount);
    });
    return total;
  }

  function goalProgress(goal) {
    var d = dates();
    var target = positiveInt(goal && goal.targetAmount);
    var saved = goalSaved(goal);
    var remaining = target - saved;
    if (remaining < 0) remaining = 0;

    var today = todayDate();
    var due = goal && isDate(goal.dueDate) ? goal.dueDate : null;
    var daysLeft = due && today && d && d.daysBetween ? d.daysBetween(today, due) : null;
    var monthsLeft = daysLeft === null ? null : Math.max(0, Math.ceil(daysLeft / 30));

    var done = target > 0 && saved >= target;
    var perMonth = null;
    if (!done) {
      if (monthsLeft === null) perMonth = null;
      else if (monthsLeft > 0) perMonth = Math.ceil(remaining / monthsLeft);
      else perMonth = remaining;
    }

    /* "41 days early" is measured from the last contribution, the only date we
       can honestly call the completion day. */
    var earlyDays = 0;
    if (done && due && d && d.daysBetween) {
      var contributions = Array.isArray(goal.contributions) ? goal.contributions : [];
      var lastDate = null;
      contributions.forEach(function (c) {
        if (c && isDate(c.date) && (!lastDate || c.date > lastDate)) lastDate = c.date;
      });
      if (!lastDate) lastDate = today;
      if (lastDate) earlyDays = Math.max(0, d.daysBetween(lastDate, due));
    }

    return {
      pct: target > 0 ? pct(saved, target) : null,
      remaining: remaining,
      monthsLeft: monthsLeft,
      perMonth: perMonth,
      done: done,
      earlyDays: earlyDays
    };
  }

  function debtTotals() {
    var out = { owedToMe: 0, iOwe: 0, net: 0, openCount: 0 };
    list("debts").forEach(function (debt) {
      if (!debt || debt.settled) return;
      var amount = positiveInt(debt.amount);
      if (!amount) return;
      out.openCount += 1;
      if (debt.direction === "iOwe") out.iOwe += amount;
      else out.owedToMe += amount;
    });
    out.net = out.owedToMe - out.iOwe;
    return out;
  }

  /* ------------------------------------------------ accounts and holdings

     The shape constants — the kind lists, the icon tables, the length ceilings,
     the colour spectrum — are read from Moon.Store rather than copied into this
     file, because the store is what enforces them when a file is read back: a
     validator that agreed with a second copy kept here would pass while writing
     records store.js then quietly repairs. They are read past the fixture
     indirection on purpose, since they describe the file format and not the
     data _selftest() stands in for. Every fallback below is unreachable on a
     loaded page — store.js is a load-order dependency of this file, and without
     it write() already refuses every mutator — and exists only so a read cannot
     throw on a page assembled in the wrong order. */

  function storeShape(name) {
    var s = Moon.Store;
    var value = s ? s[name] : null;
    return value === undefined ? null : value;
  }

  function storeCap(name, fallback) {
    var n = int(storeShape(name));
    return n > 0 ? n : fallback;
  }

  /* A kind Moon does not list is not a kind: it is a typo, or a column from
     another app's export. Storing it would park the record in a bucket no
     picker offers and no total names, so the default stands in for it. */
  function kindOf(value, listName, fallback) {
    var kinds = storeShape(listName);
    if (!Array.isArray(kinds) || kinds.indexOf(value) === -1) return fallback;
    return value;
  }

  /* §3.4 makes colour and icon part of the record, so they are stored when the
     record is written rather than invented at render time — a view falling back
     to a default would show one thing while the export carried another. */
  function toneOf(value) {
    var code = text(value).trim();
    return /^#[0-9A-Fa-f]{6}$/.test(code) ? "#" + code.slice(1).toUpperCase() : null;
  }

  /* Dealt by position, the same round-robin the v2 migration uses on
     categories: a reader who adds four accounts in a row gets four different
     colours without having to pick any of them. */
  function spectrumAt(index) {
    var spectrum = storeShape("CATEGORY_SPECTRUM");
    if (!Array.isArray(spectrum) || !spectrum.length) return null;
    var slot = int(index) % spectrum.length;
    return spectrum[slot < 0 ? slot + spectrum.length : slot];
  }

  /* An over-long icon is cut to its first code point rather than to a count of
     code units, because half of a surrogate pair renders as a replacement box
     and that reads as a bug in Moon rather than as a long string in the file.
     store.js applies the same rule when it reads a record back. */
  function iconOf(value) {
    var icon = text(value).trim();
    if (!icon) return null;
    if (icon.length <= storeCap("ICON_MAX", 4)) return icon;
    return String.fromCodePoint(icon.codePointAt(0));
  }

  function iconFor(tableName, kind) {
    var table = storeShape(tableName);
    var icon = table ? table[kind] : null;
    return icon || storeShape("FALLBACK_ICON") || "•";
  }

  /* Display only: nothing in Moon converts between currencies, so a code is
     kept as the reader wrote it, upper-cased so two spellings cannot read as
     two currencies. The reader's own setting stands in when a record says
     nothing, because that is the currency the rest of the screen is in. */
  function currencyOf(value) {
    var code = text(value).trim();
    if (/^[A-Za-z]{3}$/.test(code)) return code.toUpperCase();
    var preferred = text(settings().currency).trim();
    return /^[A-Za-z]{3}$/.test(preferred) ? preferred.toUpperCase() : "TRY";
  }

  function byDateAscending(a, b) {
    var left = text(a && a.date);
    var right = text(b && b.date);
    return left < right ? -1 : (left > right ? 1 : 0);
  }

  /* §3.3's four implied decimal places. The scale lives in Moon.Money so the
     parser, the formatter and this arithmetic can never disagree about where
     the point sits. */
  function quantityScale() {
    var m = money();
    var scale = m ? int(m.QUANTITY_SCALE) : 0;
    return scale > 0 ? scale : 1;
  }

  /* A stored quantity, a unit cost and a unit price are all non-negative
     integers in their own unit. A patch value that cannot be read as one says
     nothing, and leaving the stored number alone is better than writing a zero
     the reader never typed. */
  function isCount(value) {
    if (value === null || value === undefined || value === "") return false;
    var n = Number(value);
    return isFinite(n) && n >= 0;
  }

  /* An opening balance is the one amount in Moon allowed to be negative, so it
     is checked for being readable rather than for being positive. */
  function isSignedAmount(value) {
    if (value === null || value === undefined || value === "") return false;
    return isFinite(Number(value));
  }

  /* The account on an entry is stored as an id or as null, the same two shapes
     store.js reads back, so a record the model writes and a record the store
     repairs cannot differ. The id is not checked against the account list: an
     entry whose account was deleted is detached by removeAccount, and an id an
     importer carried from a file is the reader's to correct, not this file's to
     throw away. */
  function accountRef(value) {
    var id = text(value).trim();
    return id ? id : null;
  }

  function accounts(opts) {
    var o = opts || {};
    return list("accounts").filter(function (account) {
      if (!account || !account.id) return false;
      if (!o.all && account.archived) return false;
      if (o.kind && account.kind !== o.kind) return false;
      return true;
    });
  }

  function accountById(id) {
    if (!id) return null;
    var all = list("accounts");
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  /* Net movement per account in one pass over the ledger. The accounts screen
     asks for every balance at once, and a scan per account turns a long ledger
     into a pause the reader can see. */
  function accountMovements() {
    var out = Object.create(null);
    list("entries").forEach(function (e) {
      if (!e || !e.accountId || !isDate(e.date)) return;
      var amount = positiveInt(e.amount);
      if (!amount) return;
      var running = out[e.accountId] || 0;
      out[e.accountId] = direction(e) === "in" ? running + amount : running - amount;
    });
    return out;
  }

  /* §3.2: opening plus what came in, minus what went out. The opening keeps its
     sign — a card starts the month owing money — which makes an account balance
     the one reading in Moon allowed to be negative without being an error. */
  function accountBalance(id) {
    var account = accountById(id);
    if (!account) return 0;
    return int(account.opening) + (accountMovements()[id] || 0);
  }

  function accountTotals() {
    var movements = accountMovements();
    var byKind = Object.create(null);
    var out = { total: 0, byKind: byKind, count: 0 };
    /* An archived account is one the reader closed and it is off the accounts
       screen, so carrying it here would leave the total above the cards
       disagreeing with the sum of the cards under it. */
    accounts().forEach(function (account) {
      var balance = int(account.opening) + (movements[account.id] || 0);
      out.total += balance;
      out.count += 1;
      byKind[account.kind] = (byKind[account.kind] || 0) + balance;
    });
    return out;
  }

  /* §5.1's line under each card: what actually moved through the account this
     period. The opening balance is deliberately absent — it is where the
     account started, not something that moved. */
  function accountFlow(id, periodKey) {
    var flow = { in: 0, out: 0, count: 0 };
    var key = periodKey || currentPeriodKey();
    if (!id || !key) return flow;
    entries({ period: key }).forEach(function (e) {
      if (!e || e.accountId !== id) return;
      var amount = positiveInt(e.amount);
      if (!amount) return;
      flow.count += 1;
      if (direction(e) === "in") flow.in += amount;
      else flow.out += amount;
    });
    return flow;
  }

  function investments(opts) {
    var o = opts || {};
    return list("investments").filter(function (record) {
      if (!record || !record.id) return false;
      if (!o.all && record.archived) return false;
      if (o.kind && record.kind !== o.kind) return false;
      return true;
    });
  }

  function investmentById(id) {
    if (!id) return null;
    var all = list("investments");
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  /* §3.3: quantity carries four implied decimals, so dividing by the scale is
     what turns a stored 5000 back into half a unit. Each of the two products is
     rounded exactly once and the gain is the difference between those two
     integers, never a third rounding — otherwise half a kuruş of rounding
     error surfaces as a gain the reader never made. */
  function investmentValue(record) {
    var scale = quantityScale();
    var quantity = positiveInt(record && record.quantity);
    var value = Math.round(quantity * positiveInt(record && record.unitPrice) / scale);
    var cost = Math.round(quantity * positiveInt(record && record.unitCost) / scale);
    var gain = value - cost;
    /* A gain measured against nothing has no percentage: a holding entered
       without a cost is not up by infinity, it is simply uncosted. */
    return {
      value: value,
      cost: cost,
      gain: gain,
      gainRatio: cost > 0 ? pct(gain, cost) : null
    };
  }

  function investmentTotals() {
    var byKind = Object.create(null);
    var out = { value: 0, cost: 0, gain: 0, gainRatio: null, byKind: byKind, kinds: [], count: 0 };
    investments().forEach(function (record) {
      var reading = investmentValue(record);
      out.value += reading.value;
      out.cost += reading.cost;
      out.count += 1;
      var group = byKind[record.kind];
      if (!group) {
        group = { kind: record.kind, value: 0, cost: 0, gain: 0, share: null, count: 0 };
        byKind[record.kind] = group;
        out.kinds.push(group);
      }
      group.value += reading.value;
      group.cost += reading.cost;
      group.gain += reading.gain;
      group.count += 1;
    });
    out.gain = out.value - out.cost;
    if (out.cost > 0) out.gainRatio = pct(out.gain, out.cost);
    /* §5.2 draws the breakdown as a stacked bar, read widest segment first. The
       share is handed over already computed so the bar and the legend under it
       cannot round the same number two different ways. */
    out.kinds.forEach(function (group) { group.share = pct(group.value, out.value); });
    out.kinds = util.sortBy(out.kinds, function (group) { return group.value; }, true);
    return out;
  }

  /* The value-over-time chart: one point per date some holding carries a price
     for, oldest first, each point worth what every holding was worth that day
     at the newest price typed on or before it. A holding with no price yet
     counts as nothing rather than as its cost, because the chart is a record of
     what the reader measured and before the first price there is no
     measurement. A holding priced only before the window therefore keeps its
     last price across every point inside it. */
  function investmentSeries(months) {
    var holdings = investments();
    if (!holdings.length) return [];

    var scale = quantityScale();
    var asked = int(months);
    var monthsBack = asked > 0 ? asked : SERIES_MONTHS;
    var cutoff = null;
    var d = dates();
    var current = currentPeriodKey();
    if (d && d.shiftPeriod && current) {
      var range = periodRange(d.shiftPeriod(current, -(monthsBack - 1)));
      if (range) cutoff = range.start;
    }

    /* Sorted locally because the walk below reads each history front to back
       and only store.js guarantees the order of a file it has read. */
    var histories = holdings.map(function (record) {
      return (Array.isArray(record.history) ? record.history : [])
        .filter(function (point) { return point && isDate(point.date); })
        .sort(byDateAscending);
    });

    var seen = Object.create(null);
    histories.forEach(function (rows) {
      rows.forEach(function (point) { seen[point.date] = true; });
    });
    var days = Object.keys(seen).sort();

    var cursors = holdings.map(function () { return 0; });
    var prices = holdings.map(function () { return null; });
    var out = [];
    days.forEach(function (date) {
      var total = 0;
      for (var i = 0; i < holdings.length; i += 1) {
        var rows = histories[i];
        while (cursors[i] < rows.length && rows[cursors[i]].date <= date) {
          prices[i] = positiveInt(rows[cursors[i]].unitPrice);
          cursors[i] += 1;
        }
        if (prices[i] === null) continue;
        total += Math.round(positiveInt(holdings[i].quantity) * prices[i] / scale);
      }
      if (cutoff === null || date >= cutoff) out.push({ date: date, value: total });
    });
    return out;
  }

  /* §4: zeros rather than a throw on an empty collection, and never a figure
     nobody measured. `measured` is how the view tells a net worth of zero apart
     from a net worth nobody has written down yet — the second case is owed a
     sentence, not a printed ₺0,00. */
  function netWorth() {
    var cash = accountTotals();
    var holdings = investmentTotals();
    var debts = debtTotals();
    var cashTotal = int(cash.total);
    var investedTotal = int(holdings.value);
    var owedToMe = positiveInt(debts.owedToMe);
    var iOwe = positiveInt(debts.iOwe);
    var assets = cashTotal + investedTotal + owedToMe;
    return {
      cash: cashTotal,
      investments: investedTotal,
      owedToMe: owedToMe,
      iOwe: iOwe,
      assets: assets,
      liabilities: iOwe,
      total: assets - iOwe,
      measured: cash.count > 0 || holdings.count > 0 || debts.openCount > 0,
      counts: { accounts: cash.count, investments: holdings.count, debts: debts.openCount }
    };
  }

  function duplicateKey(entry) {
    if (!entry) return "";
    return text(entry.date) + "|" + positiveInt(entry.amount) + "|" + direction(entry) + "|"
      + util.searchKey(entry.note).slice(0, 24);
  }

  /* --------------------------------------------------------- validation */

  function result(errors) {
    var keys = Object.keys(errors);
    return { ok: keys.length === 0, errors: errors };
  }

  function validateEntry(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.date)) errors.date = "err.dateRequired";
    else if (!isDate(d.date)) errors.date = "err.dateInvalid";

    var amount = int(d.amount);
    if (d.amount === null || d.amount === undefined || d.amount === "") errors.amount = "err.amountRequired";
    else if (!(amount > 0)) errors.amount = "err.amountPositive";

    var cat = null;
    if (!text(d.categoryId)) {
      errors.categoryId = "err.categoryRequired";
    } else {
      cat = categoryById(d.categoryId);
      if (!cat) errors.categoryId = "err.categoryUnknown";
    }

    if (d.direction !== "in" && d.direction !== "out") {
      errors.direction = "err.directionInvalid";
    } else if (cat && cat.kind === "income" && d.direction !== "in") {
      errors.direction = "err.directionMismatch";
    } else if (cat && cat.kind === "expense" && d.direction !== "out") {
      errors.direction = "err.directionMismatch";
    }

    if (text(d.note).length > 200) errors.note = "err.noteTooLong";

    return result(errors);
  }

  function validateLimit(draft) {
    var errors = {};
    var d = draft || {};
    var limitCat = text(d.categoryId) ? categoryById(d.categoryId) : null;
    if (!text(d.categoryId)) errors.categoryId = "err.categoryRequired";
    else if (!limitCat) errors.categoryId = "err.categoryUnknown";
    /* A cap belongs to spending. periodSummary now ignores a limit parked on an
       income category, so accepting one would store a row nothing ever reads. */
    else if (limitCat.kind === "income") errors.categoryId = "err.limitOnIncome";
    if (d.amount !== null && d.amount !== undefined && d.amount !== "" && int(d.amount) < 0) {
      errors.amount = "err.amountPositive";
    }
    return result(errors);
  }

  function validateRecurring(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.name).trim()) errors.name = "err.nameRequired";
    else if (text(d.name).length > 200) errors.name = "err.noteTooLong";

    if (!(int(d.amount) > 0)) errors.amount = "err.amountPositive";

    if (!text(d.categoryId)) errors.categoryId = "err.categoryRequired";
    else if (!categoryById(d.categoryId)) errors.categoryId = "err.categoryUnknown";

    if (d.direction !== "in" && d.direction !== "out") errors.direction = "err.directionInvalid";

    var day = int(d.dayOfMonth);
    if (!(day >= 1 && day <= 31)) errors.dayOfMonth = "err.dayOfMonthRange";

    if (!text(d.startDate)) errors.startDate = "err.dateRequired";
    else if (!isDate(d.startDate)) errors.startDate = "err.dateInvalid";

    if (text(d.endDate)) {
      if (!isDate(d.endDate)) errors.endDate = "err.dateInvalid";
      else if (isDate(d.startDate) && d.endDate < d.startDate) errors.endDate = "err.dateOrder";
    }

    return result(errors);
  }

  function validateGoal(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.name).trim()) errors.name = "err.nameRequired";
    else if (text(d.name).length > 200) errors.name = "err.noteTooLong";

    if (!(int(d.targetAmount) > 0)) errors.targetAmount = "err.amountPositive";
    if (d.savedAmount !== null && d.savedAmount !== undefined && int(d.savedAmount) < 0) {
      errors.savedAmount = "err.amountPositive";
    }
    if (text(d.dueDate) && !isDate(d.dueDate)) errors.dueDate = "err.dateInvalid";

    return result(errors);
  }

  function validateDebt(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.person).trim()) errors.person = "err.personRequired";
    else if (text(d.person).length > 200) errors.person = "err.noteTooLong";

    if (!(int(d.amount) > 0)) errors.amount = "err.amountPositive";
    if (d.direction !== "owedToMe" && d.direction !== "iOwe") errors.direction = "err.directionInvalid";

    if (!text(d.date)) errors.date = "err.dateRequired";
    else if (!isDate(d.date)) errors.date = "err.dateInvalid";

    if (text(d.dueDate)) {
      if (!isDate(d.dueDate)) errors.dueDate = "err.dateInvalid";
      else if (isDate(d.date) && d.dueDate < d.date) errors.dueDate = "err.dateOrder";
    }
    if (text(d.note).length > 200) errors.note = "err.noteTooLong";

    return result(errors);
  }

  /* A name longer than the ceiling is not a refusal. The add row carries a
     maxlength, so a long name was pasted rather than typed, and cutting it to
     the stored length is exactly what store.js does when it reads the same
     record back — refusing the save would leave the reader with an error they
     cannot see the cause of. The empty name is the real refusal: a nameless
     account cannot be told from another nameless account. */
  function validateAccount(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.name).trim()) errors.name = "err.nameRequired";

    /* An omitted opening balance is zero rather than an error: most accounts
       are added mid-month with whatever is in them today, and the reader who
       does not know the figure should not be stopped by it. */
    var stated = d.opening !== null && d.opening !== undefined && d.opening !== "";
    if (stated && !isSignedAmount(d.opening)) errors.opening = "err.badAmount";

    return result(errors);
  }

  function validateInvestment(draft) {
    var errors = {};
    var d = draft || {};

    if (!text(d.name).trim()) errors.name = "err.nameRequired";

    /* The view hands over a quantity Moon.Money.parseQuantity has already
       turned into four implied decimals, so a fraction arriving here is a
       caller that skipped the parser rather than a reader who typed badly.
       Zero is accepted: a holding the reader has sold but still wants to watch
       the price of is a position of nothing, not a broken record. */
    var quantity = Number(d.quantity);
    if (d.quantity === null || d.quantity === undefined || d.quantity === "" ||
        !isFinite(quantity) || quantity < 0 || Math.round(quantity) !== quantity) {
      errors.quantity = "err.quantityInvalid";
    }

    /* Without a price there is nothing to measure, which is why this is the one
       required number on a holding and the cost is not. */
    if (d.unitPrice === null || d.unitPrice === undefined || d.unitPrice === "") {
      errors.unitPrice = "err.priceRequired";
    } else if (!isCount(d.unitPrice)) {
      errors.unitPrice = "err.badAmount";
    }

    if (d.unitCost !== null && d.unitCost !== undefined && d.unitCost !== "" &&
        !isCount(d.unitCost)) {
      errors.unitCost = "err.badAmount";
    }

    if (text(d.note).length > storeCap("NOTE_MAX", 200)) errors.note = "err.noteTooLong";
    if (text(d.priceDate) && !isDate(d.priceDate)) errors.priceDate = "err.dateInvalid";

    return result(errors);
  }

  /* ------------------------------------------------------------- writing */

  function write(reason, mutator, opts) {
    var s = store();
    if (!s || !s.update) return null;
    var carried = null;
    var options = { reason: reason };
    if (opts && opts.immediate) options.immediate = true;
    s.update(function (draft) {
      carried = mutator(draft);
    }, options);
    return carried;
  }

  function bucket(draft, name) {
    if (!Array.isArray(draft[name])) draft[name] = [];
    return draft[name];
  }

  function stamp() {
    /* A timestamp, not a civil date: the ISO form is correct here and is never
       sliced into a date. */
    return new Date().toISOString();
  }

  function normalizeEntry(draft) {
    var cat = categoryById(draft.categoryId);
    var fixed = typeof draft.fixed === "boolean" ? draft.fixed : !!(cat && cat.fixed);
    return {
      id: util.id("e"),
      date: draft.date,
      amount: positiveInt(draft.amount),
      direction: draft.direction === "in" ? "in" : "out",
      categoryId: draft.categoryId,
      /* §3.2: the account is extra information, so a draft that says nothing
         about one is written with null rather than refused, and the record
         counts in every total it counted in before accounts existed. */
      accountId: accountRef(draft.accountId),
      note: text(draft.note).slice(0, 200),
      fixed: fixed,
      source: text(draft.source) || "manual",
      confirmed: draft.confirmed === false ? false : true,
      recurringId: draft.recurringId || null,
      createdAt: text(draft.createdAt) || stamp()
    };
  }

  function addEntry(draft) {
    if (!validateEntry(draft).ok) return null;
    var record = normalizeEntry(draft);
    return write("entry:add", function (draft) {
      bucket(draft, "entries").push(record);
      return record.id;
    });
  }

  function addEntries(drafts) {
    var rows = Array.isArray(drafts) ? drafts : [];
    var records = [];
    rows.forEach(function (draft) {
      if (validateEntry(draft).ok) records.push(normalizeEntry(draft));
    });
    if (!records.length) return [];
    return write("entry:addMany", function (draft) {
      var rows = bucket(draft, "entries");
      records.forEach(function (record) { rows.push(record); });
      return records.map(function (record) { return record.id; });
    }, { immediate: true }) || [];
  }

  /* The sample month is cleared by looking for records it planted. A reader who
     edits one of those rows — their own limit on a sample category, their own
     contribution to a sample goal — has taken it over, and clearing the sample
     must not take it back. Changing a record hands it to the reader by stamping
     an ordinary source on it; Sample.isSampleRecord honours that over the id the
     record was born with, and ids stay put so nothing that points at them breaks. */
  function claim(record) {
    if (!record) return record;
    if (record.source === "sample" || String(record.id || "").indexOf("_sample_") === 1) {
      record.source = "manual";
    }
    return record;
  }

  var ENTRY_FIELDS = ["date", "amount", "direction", "categoryId", "accountId", "note",
    "fixed", "source", "confirmed", "recurringId"];

  function updateEntry(id, patch) {
    if (!id || !patch) return null;
    var current = null;
    list("entries").forEach(function (e) { if (e && e.id === id) current = e; });
    if (!current) return null;

    var merged = util.clone(current);
    ENTRY_FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
    });

    /* Moving a record to another category has to move its fixed/variable
       answer too, or correcting a misfiled row leaves the daily allowance
       wrong: spending counted as fixed never leaves the pool, so the panel
       keeps handing out money that is already gone.
       Every record carries a `fixed` boolean even when it only inherited one,
       so the two cases are told apart by the category the record is leaving: a
       value that still agrees with it was inherited and follows the record to
       its new home, while a value that disagrees was set on the record itself
       and is kept. An explicit `fixed` in the patch always wins. */
    if (Object.prototype.hasOwnProperty.call(patch, "categoryId") &&
        !Object.prototype.hasOwnProperty.call(patch, "fixed") &&
        merged.categoryId !== current.categoryId) {
      var leaving = categoryById(current.categoryId);
      var inherited = typeof current.fixed !== "boolean" ||
        !!current.fixed === !!(leaving && leaving.fixed);
      if (inherited) merged.fixed = !!(categoryById(merged.categoryId) || {}).fixed;
    }

    if (!validateEntry(merged).ok) return null;
    merged.amount = positiveInt(merged.amount);
    merged.accountId = accountRef(merged.accountId);
    merged.note = text(merged.note).slice(0, 200);
    claim(merged);

    return write("entry:update", function (draft) {
      var rows = bucket(draft, "entries");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          rows[i] = merged;
          return id;
        }
      }
      return null;
    });
  }

  /* Removals hand back the record so the undo strip can put it straight back. */
  function removeEntry(id) {
    if (!id) return null;
    return write("entry:remove", function (draft) {
      var rows = bucket(draft, "entries");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          return rows.splice(i, 1)[0];
        }
      }
      return null;
    });
  }

  function removeEntries(ids) {
    var wanted = Object.create(null);
    (Array.isArray(ids) ? ids : []).forEach(function (id) { if (id) wanted[id] = true; });
    if (!Object.keys(wanted).length) return [];
    return write("entry:removeMany", function (draft) {
      var rows = bucket(draft, "entries");
      var removed = [];
      for (var i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i] && wanted[rows[i].id]) removed.unshift(rows.splice(i, 1)[0]);
      }
      return removed;
    }, { immediate: true }) || [];
  }

  function confirmEntries(ids) {
    var wanted = Object.create(null);
    (Array.isArray(ids) ? ids : []).forEach(function (id) { if (id) wanted[id] = true; });
    if (!Object.keys(wanted).length) return 0;
    return write("entry:confirm", function (draft) {
      var count = 0;
      bucket(draft, "entries").forEach(function (e) {
        if (e && wanted[e.id] && !e.confirmed) {
          e.confirmed = true;
          count += 1;
        }
      });
      return count;
    }, { immediate: true }) || 0;
  }

  function addCategory(draft) {
    var d = draft || {};
    var name = text(d.name).trim();
    if (!name || name.length > 200) return null;
    var record = {
      id: util.id("c"),
      name: name,
      kind: d.kind === "income" ? "income" : "expense",
      fixed: !!d.fixed,
      archived: !!d.archived
    };
    return write("category:add", function (draft) {
      bucket(draft, "categories").push(record);
      return record.id;
    });
  }

  function updateCategory(id, patch) {
    if (!id || !patch) return null;
    return write("category:update", function (draft) {
      var rows = bucket(draft, "categories");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        if (Object.prototype.hasOwnProperty.call(patch, "name")) {
          var name = text(patch.name).trim();
          if (name) rows[i].name = name.slice(0, 200);
        }
        if (patch.kind === "income" || patch.kind === "expense") rows[i].kind = patch.kind;
        if (typeof patch.fixed === "boolean" && rows[i].fixed !== patch.fixed) {
          rows[i].fixed = patch.fixed;
          /* Spending is classified by the flag stamped on each entry, limits by
             the flag on the live category. Moving only the category splits the
             two: the limit leaves the daily-allowance pool while the spending
             stays in it, and the panel reports an overrun that did not happen
             (or, flipped the other way, hands out money that is already spent).
             Carrying the entries across keeps one answer to "is this fixed". */
          bucket(draft, "entries").forEach(function (entry) {
            if (entry && entry.categoryId === id) entry.fixed = patch.fixed;
          });
          bucket(draft, "recurring").forEach(function (rule) {
            if (rule && rule.categoryId === id) rule.fixed = patch.fixed;
          });
        }
        if (typeof patch.archived === "boolean") rows[i].archived = patch.archived;
        /* Colour and icon go through the same normalisers addCategory uses, so
           a value the picker could never produce — a three-digit hex, half a
           surrogate pair — is refused here rather than stored and repaired on
           the next load. An unreadable value leaves the field as it was: the
           reader asked for a change that cannot be made, and silently writing
           a different colour would be worse than writing none. */
        if (Object.prototype.hasOwnProperty.call(patch, "color")) {
          var tone = toneOf(patch.color);
          if (tone) rows[i].color = tone;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "icon")) {
          var glyph = iconOf(patch.icon);
          if (glyph) rows[i].icon = glyph;
        }
        claim(rows[i]);
        return id;
      }
      return null;
    });
  }

  /* The fallback bucket. Category names are plain text (the contract stores the
     translated name, not the key), so the catch-all is found by comparing
     against the "other" label in both catalogs before one is created. */
  function fallbackCategoryId(draft) {
    var rows = bucket(draft, "categories");
    var wanted = [];
    var i18n = (fixtures && fixtures.I18n) || Moon.I18n;
    if (i18n && i18n.t) wanted.push(util.searchKey(i18n.t("cat.other")));
    ["tr", "en"].forEach(function (code) {
      var catalog = Moon.Lang ? Moon.Lang[code] : null;
      if (catalog && catalog["cat.other"]) wanted.push(util.searchKey(catalog["cat.other"]));
    });

    for (var i = 0; i < rows.length; i += 1) {
      if (!rows[i] || rows[i].kind === "income" || rows[i].archived) continue;
      if (wanted.indexOf(util.searchKey(rows[i].name)) !== -1) return rows[i].id;
    }

    var created = {
      id: util.id("c"),
      name: t("cat.other"),
      kind: "expense",
      fixed: false,
      archived: false
    };
    rows.push(created);
    return created.id;
  }

  function removeCategory(id) {
    if (!id) return null;
    return write("category:remove", function (draft) {
      var rows = bucket(draft, "categories");
      var index = -1;
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) index = i;
      }
      if (index === -1) return null;

      var leaving = rows[index];
      var targetId = fallbackCategoryId(draft);
      if (targetId === id) return null;

      var target = null;
      bucket(draft, "categories").forEach(function (row) {
        if (row && row.id === targetId) target = row;
      });
      var targetFixed = !!(target && target.fixed);

      /* No entry is ever lost with its category: they move, they do not die.
         Their fixed/variable answer moves with them under the same rule
         updateEntry follows — an inherited flag follows the move, one set on
         the record is kept. Leaving an inherited flag behind would strand
         spending outside the allowance pool while its new category's budget
         row still counts it. */
      function carry(row) {
        if (typeof row.fixed !== "boolean" || !!row.fixed === !!(leaving && leaving.fixed)) {
          row.fixed = targetFixed;
        }
        row.categoryId = targetId;
      }

      var movedEntries = 0;
      bucket(draft, "entries").forEach(function (e) {
        if (e && e.categoryId === id) {
          carry(e);
          movedEntries += 1;
        }
      });

      var movedRecurring = 0;
      bucket(draft, "recurring").forEach(function (r) {
        if (r && r.categoryId === id) {
          carry(r);
          movedRecurring += 1;
        }
      });

      var limits = bucket(draft, "limits");
      var removedLimit = false;
      for (var j = limits.length - 1; j >= 0; j -= 1) {
        if (limits[j] && limits[j].categoryId === id) {
          limits.splice(j, 1);
          removedLimit = true;
        }
      }

      /* Re-read the index: fallbackCategoryId may have appended a category. */
      for (var k = rows.length - 1; k >= 0; k -= 1) {
        if (rows[k] && rows[k].id === id) rows.splice(k, 1);
      }

      return {
        ok: true,
        targetId: targetId,
        movedEntries: movedEntries,
        movedRecurring: movedRecurring,
        removedLimit: removedLimit
      };
    }, { immediate: true });
  }

  /* The same rule as removeCategory, offered on a Store draft so a caller that
     deletes categories inside its own single write can finish the job. Sample
     .clear() is the one caller: it drops the sample categories, and any record
     the reader filed under one of them would otherwise be left pointing at a
     category that no longer exists — no ledger filter finds it, no budget row
     counts it, and the category list offers no way to repair it.
     `goneIds` maps each id about to disappear (or already gone) to the category
     record it belonged to, or to `true` when the caller no longer holds it;
     the record lets an inherited fixed/variable flag be refreshed the way
     updateEntry refreshes it. Nothing is added or removed from `categories`
     except the catch-all this may have to create. Orphaned limits are dropped
     rather than moved, because two limits on one category is the one shape
     periodSummary and budgetRows read differently. */
  function rehomeOrphans(draft, goneIds) {
    var result = { targetId: null, movedEntries: 0, movedRecurring: 0, removedLimits: 0 };
    if (!draft || !goneIds) return result;

    function isGone(id) {
      return !!id && Object.prototype.hasOwnProperty.call(goneIds, id) && !!goneIds[id];
    }

    function leftBehind(id) {
      var row = isGone(id) ? goneIds[id] : null;
      return row && typeof row === "object" ? row : null;
    }

    var entryRows = bucket(draft, "entries");
    var recurringRows = bucket(draft, "recurring");
    var limitRows = bucket(draft, "limits");

    var needsHome = entryRows.some(function (e) { return e && isGone(e.categoryId); }) ||
      recurringRows.some(function (r) { return r && isGone(r.categoryId); });

    for (var i = limitRows.length - 1; i >= 0; i -= 1) {
      if (limitRows[i] && isGone(limitRows[i].categoryId)) {
        limitRows.splice(i, 1);
        result.removedLimits += 1;
      }
    }

    if (!needsHome) return result;

    var targetId = fallbackCategoryId(draft);
    result.targetId = targetId;
    if (isGone(targetId)) return result;      /* nothing safe to move into */

    var target = null;
    bucket(draft, "categories").forEach(function (row) {
      if (row && row.id === targetId) target = row;
    });
    var targetFixed = !!(target && target.fixed);

    /* Same rule as updateEntry: a flag that still agrees with the category the
       record is leaving was inherited and follows it; one that disagrees was
       set on the record and stays. */
    function rehome(row) {
      var was = leftBehind(row.categoryId);
      if (typeof row.fixed !== "boolean" || (was && !!row.fixed === !!was.fixed)) {
        row.fixed = targetFixed;
      }
      row.categoryId = targetId;
    }

    entryRows.forEach(function (e) {
      if (e && isGone(e.categoryId)) {
        rehome(e);
        result.movedEntries += 1;
      }
    });
    recurringRows.forEach(function (r) {
      if (r && isGone(r.categoryId)) {
        rehome(r);
        result.movedRecurring += 1;
      }
    });

    return result;
  }

  function setLimit(categoryId, minor) {
    if (!categoryId) return null;
    var amount = minor === null || minor === undefined ? null : positiveInt(minor);
    /* Clearing one is always allowed — a limit that arrived on an income
       category through a hand-edited backup has to be removable. Setting one
       is not: see validateLimit. */
    if (amount) {
      var target = categoryById(categoryId);
      if (target && target.kind === "income") return null;
    }
    return write("limit:set", function (draft) {
      /* Budgeting a sample category makes that category the reader's too.
         Claiming only the limit is not enough: clearing the sample month would
         take the category with it, and a limit whose category is gone is
         dropped as an orphan — the reader's figure would disappear by a side
         door. A record is only as safe as what it hangs from. */
      if (amount) {
        var rows = bucket(draft, "categories");
        for (var c = 0; c < rows.length; c += 1) {
          if (rows[c] && rows[c].id === categoryId) {
            claim(rows[c]);
            break;
          }
        }
      }

      var limits = bucket(draft, "limits");
      for (var i = limits.length - 1; i >= 0; i -= 1) {
        if (!limits[i] || limits[i].categoryId !== categoryId) continue;
        if (amount === null || amount === 0) {
          limits.splice(i, 1);
          return null;
        }
        limits[i].amount = amount;
        claim(limits[i]);
        return limits[i].id;
      }
      if (amount === null || amount === 0) return null;
      var record = { id: util.id("l"), categoryId: categoryId, amount: amount };
      limits.push(record);
      return record.id;
    });
  }

  /* ------------------------------------------------- budget template (2/2) */

  /* The rows the reader ticked, written in ONE update: nine limits are one
     decision, so they are one entry in the undo/change history and one write to
     storage, not nine. Rows the reader could not have been offered (an income
     category, a vanished one, a zero suggestion) are skipped silently — the
     list they chose from never contained them. Returns how many limits were
     written, so the UI can say it without counting again. */
  function applyLimitSuggestions(rows) {
    var wanted = [];
    var seen = Object.create(null);
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !row.categoryId) return;
      var amount = positiveInt(row.suggested);
      if (!amount) return;
      var cat = categoryById(row.categoryId);
      if (!cat || cat.kind === "income") return;
      /* The same category twice would be written twice and counted twice; the
         last value the caller passed is the one that would survive anyway. */
      if (seen[row.categoryId] !== undefined) {
        wanted[seen[row.categoryId]].amount = amount;
        return;
      }
      seen[row.categoryId] = wanted.length;
      wanted.push({ categoryId: row.categoryId, amount: amount });
    });
    if (!wanted.length) return 0;

    return write("limit:suggest", function (draft) {
      var limits = bucket(draft, "limits");
      var categoryRows = bucket(draft, "categories");
      var applied = 0;

      wanted.forEach(function (row) {
        /* Same reason setLimit claims: budgeting a sample category makes that
           category the reader's, or clearing the sample month would take their
           figure with it through the orphan door. */
        for (var c = 0; c < categoryRows.length; c += 1) {
          if (categoryRows[c] && categoryRows[c].id === row.categoryId) {
            claim(categoryRows[c]);
            break;
          }
        }
        var found = false;
        for (var i = 0; i < limits.length; i += 1) {
          if (!limits[i] || limits[i].categoryId !== row.categoryId) continue;
          limits[i].amount = row.amount;
          claim(limits[i]);
          found = true;
          break;
        }
        if (!found) {
          limits.push({ id: util.id("l"), categoryId: row.categoryId, amount: row.amount });
        }
        applied += 1;
      });

      return applied;
    }, { immediate: true }) || 0;
  }

  function addRecurring(draft) {
    if (!validateRecurring(draft).ok) return null;
    var d = draft;
    var cat = categoryById(d.categoryId);
    var record = {
      id: util.id("r"),
      name: text(d.name).trim().slice(0, 200),
      amount: positiveInt(d.amount),
      direction: d.direction === "in" ? "in" : "out",
      categoryId: d.categoryId,
      dayOfMonth: util.clamp(int(d.dayOfMonth), 1, 31),
      fixed: typeof d.fixed === "boolean" ? d.fixed : !!(cat && cat.fixed),
      startDate: d.startDate,
      endDate: isDate(d.endDate) ? d.endDate : null,
      active: d.active === false ? false : true,
      lastGeneratedPeriod: text(d.lastGeneratedPeriod) || null
    };
    return write("recurring:add", function (draft) {
      bucket(draft, "recurring").push(record);
      return record.id;
    });
  }

  var RECURRING_FIELDS = ["name", "amount", "direction", "categoryId", "dayOfMonth",
    "fixed", "startDate", "endDate", "active"];

  function updateRecurring(id, patch) {
    if (!id || !patch) return null;
    var current = null;
    list("recurring").forEach(function (r) { if (r && r.id === id) current = r; });
    if (!current) return null;

    var merged = util.clone(current);
    RECURRING_FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
    });
    if (!validateRecurring(merged).ok) return null;
    merged.amount = positiveInt(merged.amount);
    merged.dayOfMonth = util.clamp(int(merged.dayOfMonth), 1, 31);
    merged.name = text(merged.name).trim().slice(0, 200);
    merged.endDate = isDate(merged.endDate) ? merged.endDate : null;
    claim(merged);

    return write("recurring:update", function (draft) {
      var rows = bucket(draft, "recurring");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          rows[i] = merged;
          return id;
        }
      }
      return null;
    });
  }

  function removeRecurring(id) {
    if (!id) return null;
    return write("recurring:remove", function (draft) {
      var rows = bucket(draft, "recurring");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) return rows.splice(i, 1)[0];
      }
      return null;
    });
  }

  function toggleRecurring(id) {
    if (!id) return null;
    return write("recurring:toggle", function (draft) {
      var rows = bucket(draft, "recurring");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          rows[i].active = !rows[i].active;
          claim(rows[i]);
          return rows[i].active;
        }
      }
      return null;
    });
  }

  /* Only the period asked for. A rule that missed three months does not get
     three entries: the app is a ledger, not a backfill machine. */
  function generateRecurring(periodKey) {
    if (!periodKey) return 0;

    var due = [];
    list("recurring").forEach(function (r) {
      var date = recurringDue(r, periodKey);
      if (date) due.push({ id: r.id, date: date, recurring: r });
    });
    if (!due.length) return 0;

    var cats = categoryMap();
    var records = due.map(function (row) {
      var r = row.recurring;
      var cat = cats[r.categoryId];
      return {
        id: util.id("e"),
        date: row.date,
        amount: positiveInt(r.amount),
        direction: r.direction === "in" ? "in" : "out",
        categoryId: r.categoryId,
        /* A rule says nothing about which account the payment leaves from, so
           a generated entry starts unattached like any other. */
        accountId: null,
        note: text(r.name).slice(0, 200),
        fixed: typeof r.fixed === "boolean" ? r.fixed : !!(cat && cat.fixed),
        source: "recurring",
        confirmed: true,
        recurringId: r.id,
        createdAt: stamp()
      };
    });

    return write("recurring:generate", function (draft) {
      var rows = bucket(draft, "entries");
      var stampedIds = Object.create(null);
      var count = 0;
      records.forEach(function (record) {
        if (!record.amount) return;
        rows.push(record);
        stampedIds[record.recurringId] = true;
        count += 1;
      });
      /* The period stamp is what stops a second run in the same period. */
      bucket(draft, "recurring").forEach(function (r) {
        if (r && stampedIds[r.id]) r.lastGeneratedPeriod = periodKey;
      });
      return count;
    }, { immediate: true }) || 0;
  }

  /* ---------------------------------------------- recurring detection (2/2) */

  /* Turn one detection into a real rule, in ONE update.
     The entries that proved the pattern are already in the ledger, so the rule
     is stamped with the period in progress: generateRecurring reads that stamp
     as "this period is done" and the rule first produces an entry in the NEXT
     period. Without the stamp, pressing this button would duplicate every
     occurrence the reader just looked at.
     `opts.fixed` moves the occurrences out of the daily-allowance pool.
     `opts.markCategoryFixed` moves the whole category, and then — by the same
     rule updateCategory follows — every entry and rule in that category moves
     with it, because spending is classified by the flag on each record and
     limits by the flag on the category; splitting the two makes the panel
     report an overrun that did not happen.
     Returns `{recurringId, markedFixed}`, where markedFixed counts the entry
     records whose flag this call actually turned on. */
  function promoteToRecurring(detection, opts) {
    var o = opts || {};
    var det = detection || {};
    var refused = { recurringId: null, markedFixed: 0 };

    var cat = categoryById(det.categoryId);
    if (!cat) return refused;

    var occurrences = Array.isArray(det.occurrences) ? det.occurrences : [];
    var startDate = null;
    occurrences.forEach(function (row) {
      if (row && isDate(row.date) && (!startDate || row.date < startDate)) startDate = row.date;
    });
    if (!startDate) startDate = todayDate();

    var markCategory = o.markCategoryFixed === true;
    var fixed = typeof o.fixed === "boolean" ? o.fixed : !!cat.fixed;
    if (markCategory) fixed = true;

    var record = {
      id: util.id("r"),
      name: text(det.name).trim().slice(0, 200) || text(cat.name).trim(),
      amount: positiveInt(det.amount),
      direction: det.direction === "in" ? "in" : "out",
      categoryId: det.categoryId,
      dayOfMonth: util.clamp(int(det.dayOfMonth) || 1, 1, 31),
      fixed: fixed,
      startDate: startDate,
      endDate: null,
      active: true,
      lastGeneratedPeriod: currentPeriodKey(o)
    };
    if (!validateRecurring(record).ok) return refused;

    var markIds = Object.create(null);
    if (o.fixed === true) {
      occurrences.forEach(function (row) {
        if (row && row.entryId) markIds[row.entryId] = true;
      });
    }

    return write("recurring:promote", function (draft) {
      bucket(draft, "recurring").push(record);

      var marked = 0;
      bucket(draft, "entries").forEach(function (e) {
        if (!e) return;
        var wanted = markIds[e.id] === true ||
          (markCategory && e.categoryId === record.categoryId);
        if (!wanted || e.fixed === true) return;
        e.fixed = true;
        marked += 1;
      });

      if (markCategory) {
        bucket(draft, "categories").forEach(function (row) {
          if (row && row.id === record.categoryId) {
            row.fixed = true;
            claim(row);
          }
        });
        bucket(draft, "recurring").forEach(function (rule) {
          if (rule && rule.categoryId === record.categoryId) rule.fixed = true;
        });
      }

      return { recurringId: record.id, markedFixed: marked };
    }, { immediate: true }) || refused;
  }

  function addGoal(draft) {
    if (!validateGoal(draft).ok) return null;
    var d = draft;
    var contributions = (Array.isArray(d.contributions) ? d.contributions : [])
      .filter(function (c) { return c && isDate(c.date) && int(c.amount) > 0; })
      .map(function (c) { return { date: c.date, amount: positiveInt(c.amount) }; });
    var saved = typeof d.savedAmount === "number" ? positiveInt(d.savedAmount) : 0;
    if (!saved && contributions.length) {
      contributions.forEach(function (c) { saved += c.amount; });
    }
    var record = {
      id: util.id("g"),
      name: text(d.name).trim().slice(0, 200),
      targetAmount: positiveInt(d.targetAmount),
      savedAmount: saved,
      dueDate: isDate(d.dueDate) ? d.dueDate : null,
      contributions: contributions
    };
    return write("goal:add", function (draft) {
      bucket(draft, "goals").push(record);
      return record.id;
    });
  }

  function updateGoal(id, patch) {
    if (!id || !patch) return null;
    return write("goal:update", function (draft) {
      var rows = bucket(draft, "goals");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        if (Object.prototype.hasOwnProperty.call(patch, "name")) {
          var name = text(patch.name).trim();
          if (name) rows[i].name = name.slice(0, 200);
        }
        if (int(patch.targetAmount) > 0) rows[i].targetAmount = positiveInt(patch.targetAmount);
        if (typeof patch.savedAmount === "number") rows[i].savedAmount = positiveInt(patch.savedAmount);
        if (Object.prototype.hasOwnProperty.call(patch, "dueDate")) {
          rows[i].dueDate = isDate(patch.dueDate) ? patch.dueDate : null;
        }
        claim(rows[i]);
        return id;
      }
      return null;
    });
  }

  function removeGoal(id) {
    if (!id) return null;
    return write("goal:remove", function (draft) {
      var rows = bucket(draft, "goals");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) return rows.splice(i, 1)[0];
      }
      return null;
    });
  }

  function addContribution(goalId, draft) {
    var d = draft || {};
    if (!goalId || !isDate(d.date) || !(int(d.amount) > 0)) return null;
    var amount = positiveInt(d.amount);
    return write("goal:contribute", function (draft) {
      var rows = bucket(draft, "goals");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== goalId) continue;
        if (!Array.isArray(rows[i].contributions)) rows[i].contributions = [];
        rows[i].contributions.push({ date: d.date, amount: amount });
        /* savedAmount stays the stored truth and the contribution list its
           history; both move together so they can never disagree. */
        rows[i].savedAmount = positiveInt(rows[i].savedAmount) + amount;
        claim(rows[i]);
        return goalId;
      }
      return null;
    });
  }

  function addDebt(draft) {
    if (!validateDebt(draft).ok) return null;
    var d = draft;
    var record = {
      id: util.id("d"),
      person: text(d.person).trim().slice(0, 200),
      amount: positiveInt(d.amount),
      direction: d.direction === "iOwe" ? "iOwe" : "owedToMe",
      date: d.date,
      dueDate: isDate(d.dueDate) ? d.dueDate : null,
      settled: !!d.settled,
      settledDate: isDate(d.settledDate) ? d.settledDate : null,
      note: text(d.note).slice(0, 200)
    };
    return write("debt:add", function (draft) {
      bucket(draft, "debts").push(record);
      return record.id;
    });
  }

  function updateDebt(id, patch) {
    if (!id || !patch) return null;
    return write("debt:update", function (draft) {
      var rows = bucket(draft, "debts");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        if (Object.prototype.hasOwnProperty.call(patch, "person")) {
          var person = text(patch.person).trim();
          if (person) rows[i].person = person.slice(0, 200);
        }
        if (int(patch.amount) > 0) rows[i].amount = positiveInt(patch.amount);
        if (patch.direction === "iOwe" || patch.direction === "owedToMe") {
          rows[i].direction = patch.direction;
        }
        if (isDate(patch.date)) rows[i].date = patch.date;
        if (Object.prototype.hasOwnProperty.call(patch, "dueDate")) {
          rows[i].dueDate = isDate(patch.dueDate) ? patch.dueDate : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "note")) {
          rows[i].note = text(patch.note).slice(0, 200);
        }
        if (typeof patch.settled === "boolean") {
          rows[i].settled = patch.settled;
          if (!patch.settled) rows[i].settledDate = null;
        }
        claim(rows[i]);
        return id;
      }
      return null;
    });
  }

  function removeDebt(id) {
    if (!id) return null;
    return write("debt:remove", function (draft) {
      var rows = bucket(draft, "debts");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) return rows.splice(i, 1)[0];
      }
      return null;
    });
  }

  function settleDebt(id, date) {
    if (!id) return null;
    var when = isDate(date) ? date : todayDate();
    return write("debt:settle", function (draft) {
      var rows = bucket(draft, "debts");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          rows[i].settled = true;
          rows[i].settledDate = when;
          claim(rows[i]);
          return id;
        }
      }
      return null;
    });
  }

  function addAccount(draft) {
    if (!validateAccount(draft).ok) return null;
    var d = draft;
    var kind = kindOf(d.kind, "ACCOUNT_KINDS", "cash");
    var record = {
      id: util.id("a"),
      name: text(d.name).trim().slice(0, storeCap("ACCOUNT_NAME_MAX", 60)),
      kind: kind,
      opening: int(d.opening),
      currency: currencyOf(d.currency),
      color: toneOf(d.color) || spectrumAt(list("accounts").length),
      icon: iconOf(d.icon) || iconFor("ICON_BY_ACCOUNT_KIND", kind),
      archived: d.archived === true,
      createdAt: isDate(d.createdAt) ? d.createdAt : todayDate()
    };
    return write("account:add", function (draft) {
      bucket(draft, "accounts").push(record);
      return record.id;
    });
  }

  function updateAccount(id, patch) {
    if (!id || !patch) return null;
    return write("account:update", function (draft) {
      var rows = bucket(draft, "accounts");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        if (Object.prototype.hasOwnProperty.call(patch, "name")) {
          var name = text(patch.name).trim();
          if (name) rows[i].name = name.slice(0, storeCap("ACCOUNT_NAME_MAX", 60));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "kind")) {
          rows[i].kind = kindOf(patch.kind, "ACCOUNT_KINDS", rows[i].kind);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "opening") &&
            isSignedAmount(patch.opening)) {
          rows[i].opening = int(patch.opening);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "currency")) {
          rows[i].currency = currencyOf(patch.currency);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "color")) {
          var tone = toneOf(patch.color);
          if (tone) rows[i].color = tone;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "icon")) {
          var icon = iconOf(patch.icon);
          if (icon) rows[i].icon = icon;
        }
        if (typeof patch.archived === "boolean") rows[i].archived = patch.archived;
        claim(rows[i]);
        return id;
      }
      return null;
    });
  }

  /* §3.2: an account is where a payment came from, never the payment itself, so
     deleting one leaves every entry exactly as it was typed and costs it only
     the link. The count of detached entries comes back with the record because
     accounts.removed tells the reader how many entries are now unattached, and
     once the account is gone they cannot count them for themselves. */
  function removeAccount(id) {
    if (!id) return null;
    return write("account:remove", function (draft) {
      var rows = bucket(draft, "accounts");
      var removed = null;
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) {
          removed = rows.splice(i, 1)[0];
          break;
        }
      }
      if (!removed) return null;
      var detached = 0;
      bucket(draft, "entries").forEach(function (entry) {
        if (entry && entry.accountId === id) {
          entry.accountId = null;
          detached += 1;
        }
      });
      return { record: removed, detached: detached };
    });
  }

  /* §3.3: a price is only ever a price on a day, so every change to unitPrice
     leaves a row behind. One row per date — a second edit on the same day is a
     correction of that day's reading, not a second reading — and when the
     history reaches its ceiling the newest rows are the ones kept, because the
     current value and the right-hand end of the chart are read from those. */
  function recordPrice(record, unitPrice, date) {
    if (!Array.isArray(record.history)) record.history = [];
    var history = record.history;
    var replaced = false;
    for (var i = 0; i < history.length; i += 1) {
      if (history[i] && history[i].date === date) {
        /* Only the price is touched, so anything else a file carried on that
           row survives the correction. */
        history[i].unitPrice = unitPrice;
        replaced = true;
        break;
      }
    }
    if (!replaced) history.push({ date: date, unitPrice: unitPrice });
    history.sort(byDateAscending);
    var ceiling = storeCap("HISTORY_MAX", 400);
    if (history.length > ceiling) record.history = history.slice(history.length - ceiling);

    /* The stored price is the newest row rather than the one just typed, so
       filling in a price the reader missed last month cannot make the holding
       read at a stale price today. store.js repairs an unreadable unitPrice
       from the same row, so a record and its own history cannot disagree. */
    var newest = record.history[record.history.length - 1];
    record.unitPrice = newest.unitPrice;
    record.priceDate = newest.date;
  }

  function addInvestment(draft) {
    if (!validateInvestment(draft).ok) return null;
    var d = draft;
    var kind = kindOf(d.kind, "INVESTMENT_KINDS", "other");
    var unitPrice = positiveInt(d.unitPrice);
    var priceDate = isDate(d.priceDate) ? d.priceDate : todayDate();
    var record = {
      id: util.id("i"),
      name: text(d.name).trim().slice(0, storeCap("INVESTMENT_NAME_MAX", 80)),
      kind: kind,
      quantity: positiveInt(d.quantity),
      unitCost: positiveInt(d.unitCost),
      unitPrice: unitPrice,
      priceDate: priceDate,
      currency: currencyOf(d.currency),
      note: text(d.note).slice(0, storeCap("NOTE_MAX", 200)),
      color: toneOf(d.color) || spectrumAt(list("investments").length),
      icon: iconOf(d.icon) || iconFor("ICON_BY_INVESTMENT_KIND", kind),
      archived: d.archived === true,
      createdAt: isDate(d.createdAt) ? d.createdAt : todayDate(),
      /* store.js deliberately does not invent a first history row, so the price
         typed on the add row is recorded here or the holding's opening price is
         lost the first time it is corrected — and §5.2's chart, which appears
         once there are two prices, would never see the first of them. */
      history: priceDate ? [{ date: priceDate, unitPrice: unitPrice }] : []
    };
    return write("investment:add", function (draft) {
      bucket(draft, "investments").push(record);
      return record.id;
    });
  }

  function updateInvestment(id, patch) {
    if (!id || !patch) return null;
    return write("investment:update", function (draft) {
      var rows = bucket(draft, "investments");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        var record = rows[i];
        if (Object.prototype.hasOwnProperty.call(patch, "name")) {
          var name = text(patch.name).trim();
          if (name) record.name = name.slice(0, storeCap("INVESTMENT_NAME_MAX", 80));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "kind")) {
          record.kind = kindOf(patch.kind, "INVESTMENT_KINDS", record.kind);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "quantity") && isCount(patch.quantity)) {
          record.quantity = positiveInt(patch.quantity);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "unitCost") && isCount(patch.unitCost)) {
          record.unitCost = positiveInt(patch.unitCost);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "currency")) {
          record.currency = currencyOf(patch.currency);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "note")) {
          record.note = text(patch.note).slice(0, storeCap("NOTE_MAX", 200));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "color")) {
          var tone = toneOf(patch.color);
          if (tone) record.color = tone;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "icon")) {
          var icon = iconOf(patch.icon);
          if (icon) record.icon = icon;
        }
        if (typeof patch.archived === "boolean") record.archived = patch.archived;
        /* A price moved through the edit form is still a price on a day, so it
           goes through the same history as the one-field update row. */
        if (Object.prototype.hasOwnProperty.call(patch, "unitPrice") && isCount(patch.unitPrice)) {
          var when = isDate(patch.priceDate) ? patch.priceDate : todayDate();
          if (when) recordPrice(record, positiveInt(patch.unitPrice), when);
        } else if (isDate(patch.priceDate)) {
          record.priceDate = patch.priceDate;
        }
        claim(record);
        return id;
      }
      return null;
    });
  }

  function setInvestmentPrice(id, unitPrice, date) {
    if (!id || !isCount(unitPrice)) return null;
    var price = positiveInt(unitPrice);
    var when = isDate(date) ? date : todayDate();
    if (!when) return null;
    return write("investment:price", function (draft) {
      var rows = bucket(draft, "investments");
      for (var i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== id) continue;
        recordPrice(rows[i], price, when);
        claim(rows[i]);
        return id;
      }
      return null;
    });
  }

  function removeInvestment(id) {
    if (!id) return null;
    return write("investment:remove", function (draft) {
      var rows = bucket(draft, "investments");
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) return rows.splice(i, 1)[0];
      }
      return null;
    });
  }

  /* ------------------------------------------------------------- exports */

  Moon.Model = {
    categories: categories,
    categoryById: categoryById,
    categoryName: categoryName,
    entries: entries,
    limitFor: limitFor,

    periodSummary: periodSummary,
    dailyAllowance: dailyAllowance,
    allowanceTrail: allowanceTrail,
    dailyFlow: dailyFlow,
    cumulative: cumulative,
    budgetRows: budgetRows,
    yearGrid: yearGrid,
    pendingRecurring: pendingRecurring,
    suggestLimits: suggestLimits,
    detectRecurring: detectRecurring,
    goalProgress: goalProgress,
    debtTotals: debtTotals,

    accounts: accounts,
    accountById: accountById,
    accountBalance: accountBalance,
    accountTotals: accountTotals,
    accountFlow: accountFlow,

    investments: investments,
    investmentById: investmentById,
    investmentValue: investmentValue,
    investmentTotals: investmentTotals,
    investmentSeries: investmentSeries,

    netWorth: netWorth,

    validateEntry: validateEntry,
    validateLimit: validateLimit,
    validateRecurring: validateRecurring,
    validateGoal: validateGoal,
    validateDebt: validateDebt,
    validateAccount: validateAccount,
    validateInvestment: validateInvestment,

    addEntry: addEntry,
    addEntries: addEntries,
    updateEntry: updateEntry,
    removeEntry: removeEntry,
    removeEntries: removeEntries,
    confirmEntries: confirmEntries,

    addCategory: addCategory,
    updateCategory: updateCategory,
    removeCategory: removeCategory,
    rehomeOrphans: rehomeOrphans,
    setLimit: setLimit,
    applyLimitSuggestions: applyLimitSuggestions,

    addRecurring: addRecurring,
    promoteToRecurring: promoteToRecurring,
    updateRecurring: updateRecurring,
    removeRecurring: removeRecurring,
    toggleRecurring: toggleRecurring,
    generateRecurring: generateRecurring,

    addGoal: addGoal,
    updateGoal: updateGoal,
    removeGoal: removeGoal,
    addContribution: addContribution,

    addDebt: addDebt,
    updateDebt: updateDebt,
    removeDebt: removeDebt,
    settleDebt: settleDebt,

    addAccount: addAccount,
    updateAccount: updateAccount,
    removeAccount: removeAccount,

    addInvestment: addInvestment,
    updateInvestment: updateInvestment,
    setInvestmentPrice: setInvestmentPrice,
    removeInvestment: removeInvestment,

    duplicateKey: duplicateKey
  };

  /* ------------------------------------------------------------ selftest */

  /* Runs the formulas against fixtures instead of the real store, so the four
     allowance states, the drift states and the "generate once per period" rule
     are checked with `node js/model.js` style drivers, not by clicking. */
  function fixtureDates(today) {
    function fmt(y, m, d) { return y + "-" + util.pad2(m) + "-" + util.pad2(d); }
    function dim(y, m) { return new Date(y, m, 0).getDate(); }
    function toDate(value) {
      return new Date(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10));
    }
    var api = {
      today: function () { return today; },
      periodKey: function (date) { return String(date).slice(0, 7); },
      periodRange: function (key) {
        var y = +key.slice(0, 4);
        var m = +key.slice(5, 7);
        var n = dim(y, m);
        return { start: fmt(y, m, 1), end: fmt(y, m, n), days: n };
      },
      periodProgress: function (key, msd, now) {
        var range = api.periodRange(key);
        if (now < range.start) {
          return { dayIndex: 0, days: range.days, remainingDays: range.days,
            ratio: 0, isLastDay: false, isPast: false, isFuture: true };
        }
        if (now > range.end) {
          return { dayIndex: range.days, days: range.days, remainingDays: 0,
            ratio: 1, isLastDay: false, isPast: true, isFuture: false };
        }
        var index = +now.slice(8, 10);
        return {
          dayIndex: index, days: range.days, remainingDays: range.days - index + 1,
          ratio: index / range.days, isLastDay: index === range.days,
          isPast: false, isFuture: false
        };
      },
      shiftPeriod: function (key, n) {
        var y = +key.slice(0, 4);
        var m = +key.slice(5, 7) + n;
        y += Math.floor((m - 1) / 12);
        m = ((m - 1) % 12 + 12) % 12 + 1;
        return y + "-" + util.pad2(m);
      },
      eachDay: function (start, end) {
        var out = [];
        var cursor = toDate(start);
        var stop = toDate(end);
        while (cursor <= stop) {
          out.push(fmt(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()));
          cursor.setDate(cursor.getDate() + 1);
        }
        return out;
      },
      daysBetween: function (a, b) {
        return Math.round((toDate(b) - toDate(a)) / 86400000);
      },
      isWeekend: function (date) {
        var day = toDate(date).getDay();
        return day === 0 || day === 6;
      }
    };
    return api;
  }

  function selftest() {
    var failures = [];
    var checks = 0;
    /* How many times the fixture store was written. The suggestion features
       promise ONE update per decision, and that promise is only testable if the
       fixture counts the calls. */
    var writeCount = 0;

    function ok(label, condition) {
      checks += 1;
      if (!condition) failures.push(label);
    }
    function eq(label, actual, expected) {
      checks += 1;
      if (actual !== expected) failures.push(label + ": " + actual + " != " + expected);
    }

    function scene(today, overrides) {
      var base = {
        schemaVersion: 1,
        createdAt: "2026-09-01",
        settings: { lang: "tr", currency: "TRY", monthStartDay: 1 },
        categories: [
          { id: "c_rent", name: "Kira", kind: "expense", fixed: true, archived: false },
          { id: "c_groc", name: "Market", kind: "expense", fixed: false, archived: false },
          { id: "c_fun", name: "Eglence", kind: "expense", fixed: false, archived: false },
          { id: "c_trans", name: "Ulasim", kind: "expense", fixed: false, archived: false },
          { id: "c_sal", name: "Maas", kind: "income", fixed: false, archived: false }
        ],
        entries: [],
        limits: [],
        recurring: [],
        goals: [],
        debts: [],
        accounts: [],
        investments: []
      };
      var st = util.clone(base);
      if (overrides) Object.keys(overrides).forEach(function (key) { st[key] = overrides[key]; });
      fixtures = {
        Dates: fixtureDates(today),
        /* The scale is repeated here rather than read from Moon.Money on
           purpose: it checks the ×10⁴ arithmetic against the number §3.3 names,
           not against whatever money.js happens to say today. */
        Money: {
          QUANTITY_SCALE: 10000,
          pct: function (part, whole) { return whole ? Math.round((part / whole) * 100) : null; }
        },
        Store: {
          state: st,
          update: function (mutator) {
            writeCount += 1;
            mutator(st);
          }
        },
        I18n: { t: function (key) { return key; }, lang: "tr" }
      };
      return st;
    }

    function entry(id, date, amount, categoryId, extra) {
      var record = {
        id: id, date: date, amount: amount, direction: "out", categoryId: categoryId,
        note: "test " + id, source: "manual", confirmed: true, recurringId: null,
        createdAt: "2026-09-01T00:00:00.000Z"
      };
      if (extra) Object.keys(extra).forEach(function (k) { record[k] = extra[k]; });
      return record;
    }

    /* 1 — no limits at all: the hero has nothing to divide. */
    scene("2026-09-21", { entries: [entry("e1", "2026-09-05", 50000, "c_groc")] });
    var a = dailyAllowance("2026-09");
    eq("noLimits.state", a.state, "noLimits");
    eq("noLimits.perDay", a.perDay, null);

    /* 2 — healthy period: floor((pool - variable spend) / remaining days).
           Fixed rent must not touch either side of that fraction. */
    scene("2026-09-21", {
      limits: [
        { id: "l1", categoryId: "c_groc", amount: 600000 },
        { id: "l2", categoryId: "c_rent", amount: 1800000 }
      ],
      entries: [
        entry("e1", "2026-09-05", 200000, "c_groc"),
        entry("e2", "2026-09-01", 1800000, "c_rent"),
        entry("e3", "2026-09-21", 10000, "c_groc")
      ]
    });
    a = dailyAllowance("2026-09");
    eq("ok.state", a.state, "ok");
    eq("ok.remainingDays", a.remainingDays, 10);
    eq("ok.remainingAmount", a.remainingAmount, 390000);
    eq("ok.perDay", a.perDay, 39000);
    eq("ok.fixedReserved", a.fixedReserved, 1800000);
    eq("ok.spentToday", a.spentToday, 10000);
    eq("ok.perDayLeftToday", a.perDayLeftToday, 29000);

    /* 3 — overspent: negative remainder has no per-day reading. */
    scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 731200, "c_groc")]
    });
    a = dailyAllowance("2026-09");
    eq("overspent.state", a.state, "overspent");
    eq("overspent.perDay", a.perDay, null);
    eq("overspent.remainingAmount", a.remainingAmount, -131200);

    /* 4 — last day: the whole remainder is today's allowance. */
    scene("2026-09-30", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 412340, "c_groc")]
    });
    a = dailyAllowance("2026-09");
    eq("lastDay.state", a.state, "lastDay");
    eq("lastDay.perDay", a.perDay, 187660);

    /* 5 — a closed period reads as history. */
    scene("2026-10-04", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 100000, "c_groc")]
    });
    a = dailyAllowance("2026-09");
    eq("pastPeriod.state", a.state, "pastPeriod");
    eq("pastPeriod.perDay", a.perDay, null);

    /* 6 — goals and debts never move the hero number. */
    var withPlans = scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 200000, "c_groc")],
      goals: [{ id: "g1", name: "Tatil", targetAmount: 2000000, savedAmount: 450000,
        dueDate: "2027-06-01", contributions: [{ date: "2026-09-02", amount: 450000 }] }],
      debts: [{ id: "d1", person: "X", amount: 50000, direction: "owedToMe",
        date: "2026-09-10", dueDate: null, settled: false, settledDate: null, note: "" }]
    });
    var withoutPlans = dailyAllowance("2026-09").perDay;
    withPlans.goals = [];
    withPlans.debts = [];
    eq("plansAreNeutral", dailyAllowance("2026-09").perDay, withoutPlans);

    /* 7 — drift states across one period, plus the limitless row. */
    scene("2026-09-21", {
      limits: [
        { id: "l1", categoryId: "c_groc", amount: 1000000 },
        { id: "l2", categoryId: "c_fun", amount: 100000 },
        { id: "l3", categoryId: "c_trans", amount: 200000 },
        { id: "l4", categoryId: "c_rent", amount: 1800000 }
      ],
      entries: [
        entry("e1", "2026-09-05", 300000, "c_groc"),   /* expected 700000 → ahead */
        entry("e2", "2026-09-06", 90000, "c_fun"),     /* expected 70000  → behind */
        entry("e3", "2026-09-07", 260000, "c_trans"),  /* over the limit  → over  */
        entry("e4", "2026-09-01", 1800000, "c_rent")   /* fixed, paid     → done  */
      ]
    });
    var rows = budgetRows("2026-09");
    var byId = Object.create(null);
    rows.forEach(function (row) { byId[row.categoryId] = row; });
    eq("drift.ahead", byId.c_groc.driftState, "ahead");
    eq("drift.behind", byId.c_fun.driftState, "behind");
    eq("drift.over", byId.c_trans.driftState, "over");
    eq("drift.done", byId.c_rent.driftState, "done");
    eq("drift.value", byId.c_groc.drift, 400000);
    eq("drift.pct", byId.c_trans.pct, 130);
    ok("drift.fixedLast", rows[rows.length - 1].fixed === true);

    scene("2026-09-21", {
      entries: [entry("e1", "2026-09-05", 12345, "c_groc")]
    });
    rows = budgetRows("2026-09");
    eq("limitless.rowCount", rows.length, 1);
    eq("limitless.limit", rows[0].limit, null);
    eq("limitless.pct", rows[0].pct, null);
    eq("limitless.driftState", rows[0].driftState, null);

    /* 8 — the trail ends today and its last point matches the hero. */
    scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 200000, "c_groc")]
    });
    var trail = allowanceTrail("2026-09");
    eq("trail.length", trail.length, 21);
    eq("trail.reference", trail[0].reference, 20000);
    eq("trail.lastPoint", trail[20].perDay, Math.floor(400000 / 9));

    /* 9 — recurring generates once per period and never twice. */
    var st = scene("2026-09-21", {
      recurring: [{ id: "r1", name: "Spotify", amount: 6999, direction: "out",
        categoryId: "c_fun", dayOfMonth: 15, fixed: true, startDate: "2026-01-15",
        endDate: null, active: true, lastGeneratedPeriod: "2026-08" }]
    });
    eq("recurring.firstRun", generateRecurring("2026-09"), 1);
    eq("recurring.stamp", st.recurring[0].lastGeneratedPeriod, "2026-09");
    eq("recurring.secondRun", generateRecurring("2026-09"), 0);
    eq("recurring.entryCount", st.entries.length, 1);
    eq("recurring.date", st.entries[0].date, "2026-09-15");
    eq("recurring.source", st.entries[0].source, "recurring");
    eq("recurring.confirmed", st.entries[0].confirmed, true);
    ok("recurring.link", st.entries[0].recurringId === "r1");
    eq("recurring.pendingAfter", pendingRecurring("2026-09").length, 0);

    /* 10 — day 31 in a short month clamps to the last day, and a rule that
            starts later in the period does not fire early. */
    st = scene("2026-02-20", {
      recurring: [{ id: "r1", name: "Kira", amount: 1800000, direction: "out",
        categoryId: "c_rent", dayOfMonth: 31, fixed: true, startDate: "2026-01-31",
        endDate: null, active: true, lastGeneratedPeriod: "2026-01" }]
    });
    eq("clamp.count", generateRecurring("2026-02"), 1);
    eq("clamp.date", st.entries[0].date, "2026-02-28");

    st = scene("2026-09-21", {
      recurring: [{ id: "r1", name: "Yeni", amount: 5000, direction: "out",
        categoryId: "c_fun", dayOfMonth: 10, fixed: false, startDate: "2026-10-10",
        endDate: null, active: true, lastGeneratedPeriod: null }]
    });
    eq("beforeStart.count", generateRecurring("2026-09"), 0);

    /* 11 — removing a category moves its entries instead of dropping them. */
    st = scene("2026-09-21", {
      categories: [
        { id: "c_groc", name: "Market", kind: "expense", fixed: false, archived: false },
        { id: "c_other", name: "Diger", kind: "expense", fixed: false, archived: false }
      ],
      entries: [entry("e1", "2026-09-05", 12345, "c_groc")],
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }]
    });
    if (Moon.Lang) Moon.Lang.tr = Moon.Lang.tr || { "cat.other": "Diger" };
    var removal = removeCategory("c_groc");
    ok("removeCategory.ok", !!(removal && removal.ok));
    eq("removeCategory.entryKept", st.entries.length, 1);
    ok("removeCategory.moved", st.entries[0].categoryId !== "c_groc");
    eq("removeCategory.limitGone", st.limits.length, 0);

    /* 11b — the fixed/variable flag travels with the entry, so spending does
             not fall out of the allowance pool when its category is deleted. */
    st = scene("2026-09-21", {
      categories: [
        { id: "c_rent", name: "Kira", kind: "expense", fixed: true, archived: false },
        { id: "c_other", name: catchAllName(), kind: "expense", fixed: false, archived: false }
      ],
      limits: [{ id: "l1", categoryId: "c_other", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 300000, "c_rent", { fixed: true })]
    });
    eq("removeFixed.poolBefore", dailyAllowance("2026-09").remainingAmount, 600000);
    ok("removeFixed.ok", !!(removeCategory("c_rent") || {}).ok);
    eq("removeFixed.target", st.entries[0].categoryId, "c_other");
    eq("removeFixed.flagFollows", st.entries[0].fixed, false);
    eq("removeFixed.poolAfter", dailyAllowance("2026-09").remainingAmount, 300000);

    /* An override is still an override. */
    st = scene("2026-09-21", {
      categories: [
        { id: "c_rent", name: "Kira", kind: "expense", fixed: true, archived: false },
        { id: "c_other", name: catchAllName(), kind: "expense", fixed: false, archived: false }
      ],
      entries: [entry("e1", "2026-09-05", 300000, "c_rent", { fixed: false })]
    });
    removeCategory("c_rent");
    eq("removeFixed.overrideKept", st.entries[0].fixed, false);

    /* 12 — duplicate fingerprint shape. */
    scene("2026-09-21", {});
    eq("duplicateKey",
      duplicateKey({ date: "2026-09-26", amount: 24890, direction: "out", note: "A101 haftalık alisveris" }),
      "2026-09-26|24890|out|a101haftalıkalisveris");
    eq("duplicateKey.noteCap",
      duplicateKey({ date: "2026-09-26", amount: 100, direction: "out",
        note: "bir cok uzun aciklama daha da uzun" }).split("|")[3].length, 24);

    /* 12b — a limit parked on an income category is inert: it never joins the
             allowance pool (budgetRows already refuses it a row), it cannot be
             set, and it can still be cleared. */
    st = scene("2026-09-21", {
      limits: [
        { id: "l1", categoryId: "c_groc", amount: 600000 },
        { id: "l2", categoryId: "c_sal", amount: 5000000 }
      ],
      entries: []
    });
    eq("incomeLimit.pool", periodSummary("2026-09").limitVariable, 600000);
    eq("incomeLimit.total", periodSummary("2026-09").limitTotal, 600000);
    ok("incomeLimit.noRow", budgetRows("2026-09").every(function (r) {
      return r.categoryId !== "c_sal";
    }));
    ok("incomeLimit.rejected", !validateLimit({ categoryId: "c_sal", amount: 100 }).ok);
    eq("incomeLimit.errorKey",
      validateLimit({ categoryId: "c_sal", amount: 100 }).errors.categoryId, "err.limitOnIncome");
    eq("incomeLimit.setRefused", setLimit("c_sal", 100), null);
    eq("incomeLimit.notStored", st.limits.length, 2);
    setLimit("c_sal", null);
    eq("incomeLimit.clearable", st.limits.length, 1);
    ok("incomeLimit.expenseStillWorks", !!setLimit("c_fun", 100000));

    /* 12c — moving an entry to another category moves its fixed/variable
             answer with it, unless that answer was set on the record itself.
             Getting this wrong leaves spending outside the allowance pool. */
    function catchAllName() {
      var catalog = Moon.Lang ? Moon.Lang.tr : null;
      return (catalog && catalog["cat.other"]) || "cat.other";
    }

    function movedFixed(startCat, endCat, extra) {
      st = scene("2026-09-21", { entries: [entry("e1", "2026-09-05", 100, startCat, extra)] });
      updateEntry("e1", { categoryId: endCat });
      return st.entries[0].fixed;
    }
    eq("moveFixed.inheritedToVariable", movedFixed("c_rent", "c_groc", { fixed: true }), false);
    eq("moveFixed.inheritedToFixed", movedFixed("c_groc", "c_rent", { fixed: false }), true);
    eq("moveFixed.missingFlag", movedFixed("c_groc", "c_rent", null), true);
    eq("moveFixed.overrideFalseKept", movedFixed("c_rent", "c_groc", { fixed: false }), false);
    eq("moveFixed.overrideTrueKept", movedFixed("c_groc", "c_rent", { fixed: true }), true);

    st = scene("2026-09-21", { entries: [entry("e1", "2026-09-05", 100, "c_rent", { fixed: true })] });
    updateEntry("e1", { categoryId: "c_groc", fixed: true });
    eq("moveFixed.explicitPatchWins", st.entries[0].fixed, true);
    updateEntry("e1", { note: "only a note" });
    eq("moveFixed.noMoveNoChange", st.entries[0].fixed, true);

    /* The pool reading is the reason all of the above matters. */
    st = scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [entry("e1", "2026-09-05", 300000, "c_rent", { fixed: true })]
    });
    eq("moveFixed.poolBefore", dailyAllowance("2026-09").remainingAmount, 600000);
    updateEntry("e1", { categoryId: "c_groc" });
    eq("moveFixed.poolAfter", dailyAllowance("2026-09").remainingAmount, 300000);

    /* 12d — rehomeOrphans: the rule removeCategory follows, offered to a caller
             that deletes categories inside its own write (Sample.clear). */
    st = scene("2026-09-21", {
      categories: [
        { id: "c_groc", name: "Market", kind: "expense", fixed: false, archived: false },
        /* The catch-all is found by name, so it has to carry the catalog's
           own label rather than a look-alike. */
        { id: "c_other", name: catchAllName(), kind: "expense", fixed: false, archived: false }
      ],
      entries: [entry("e1", "2026-09-05", 12345, "c_gone", { fixed: true })],
      recurring: [{ id: "r1", name: "Kira", amount: 1800000, direction: "out",
        categoryId: "c_gone", dayOfMonth: 1, fixed: true, startDate: "2026-01-01",
        endDate: null, active: true, lastGeneratedPeriod: null }],
      limits: [{ id: "l1", categoryId: "c_gone", amount: 600000 },
        { id: "l2", categoryId: "c_groc", amount: 100000 }]
    });
    var gone = Object.create(null);
    gone.c_gone = { id: "c_gone", name: "Kira", kind: "expense", fixed: true, archived: false };
    var rehomed = rehomeOrphans(st, gone);
    eq("rehome.entries", rehomed.movedEntries, 1);
    eq("rehome.recurring", rehomed.movedRecurring, 1);
    eq("rehome.limitsDropped", rehomed.removedLimits, 1);
    eq("rehome.target", st.entries[0].categoryId, "c_other");
    eq("rehome.ruleTarget", st.recurring[0].categoryId, "c_other");
    eq("rehome.inheritedFixedFollows", st.entries[0].fixed, false);
    eq("rehome.limitsLeft", st.limits.length, 1);
    eq("rehome.noOrphans", entries({ period: "2026-09" }).filter(function (e) {
      return !categoryById(e.categoryId);
    }).length, 0);

    /* An override survives the re-home, and an untouched state is left alone. */
    st = scene("2026-09-21", {
      categories: [{ id: "c_other", name: catchAllName(), kind: "expense", fixed: false, archived: false }],
      entries: [entry("e1", "2026-09-05", 100, "c_gone", { fixed: true })]
    });
    rehomeOrphans(st, { c_gone: { id: "c_gone", name: "X", kind: "expense", fixed: false, archived: false } });
    eq("rehome.overrideKept", st.entries[0].fixed, true);

    st = scene("2026-09-21", { entries: [entry("e1", "2026-09-05", 100, "c_groc")] });
    var noop = rehomeOrphans(st, Object.create(null));
    eq("rehome.nothingToDo", noop.movedEntries, 0);
    eq("rehome.noCategoryCreated", st.categories.length, 5);
    eq("rehome.badCall", rehomeOrphans(null, null).movedEntries, 0);

    /* 13 — broken records must not crash a read. */
    scene("2026-09-21", {
      entries: [null, { id: "bad" }, entry("e1", "not-a-date", 100, "c_groc"),
        entry("e2", "2026-09-05", 1000, "c_missing")]
    });
    ok("defensive.entries", entries({ period: "2026-09" }).length === 1);
    ok("defensive.summary", periodSummary("2026-09").spentTotal === 1000);
    ok("defensive.flow", dailyFlow("2026-09").length === 30);
    ok("defensive.cumulative", cumulative("2026-09").points.length > 0);
    ok("defensive.yearGrid", yearGrid("2026-09").periods.length === 12);

    /* ------------------------------------------- 14 — budget suggestions */

    function byCategoryId(rowList) {
      var map = Object.create(null);
      rowList.forEach(function (row) { map[row.categoryId] = row; });
      return map;
    }

    /* 14a — median, not mean; the rounding step; the period in progress and
             income categories left out; fixed categories flagged, not hidden. */
    scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [
        entry("g1", "2026-06-10", 100000, "c_groc"),
        entry("g2", "2026-07-12", 148700, "c_groc"),
        entry("g3", "2026-08-14", 900000, "c_groc"),   /* one big month */
        entry("g4", "2026-09-05", 2000000, "c_groc"),  /* period in progress */
        entry("r1", "2026-07-01", 1800000, "c_rent"),
        entry("r2", "2026-08-01", 1800000, "c_rent"),
        entry("s1", "2026-07-25", 4200000, "c_sal", { direction: "in" }),
        entry("t1", "2026-06-03", 11000, "c_trans"),
        entry("t2", "2026-07-03", 12300, "c_trans"),
        entry("t3", "2026-08-03", 40000, "c_trans"),
        entry("f1", "2026-08-20", 7700, "c_fun")
      ]
    });
    var suggestion = suggestLimits();
    var sg = byCategoryId(suggestion.rows);
    eq("suggest.rowCount", suggestion.rows.length, 4);
    eq("suggest.basis", suggestion.basis.periods.join(","), "2026-06,2026-07,2026-08");
    eq("suggest.entryCount", suggestion.basis.entryCount, 9);
    ok("suggest.complete", suggestion.basis.complete === true);
    /* median 148.700 → 150.000, where the mean (382.900) would say 390.000 */
    eq("suggest.median", sg.c_groc.suggested, 150000);
    eq("suggest.smallStep", sg.c_trans.suggested, 13000);     /* median 12.300 ↑ 10 TL step */
    eq("suggest.smallStepLow", sg.c_fun.suggested, 8000);     /* 7.700 ↑ 8.000 */
    eq("suggest.current", sg.c_groc.current, 600000);
    eq("suggest.noCurrent", sg.c_trans.current, null);
    ok("suggest.noIncomeRow", suggestion.rows.every(function (row) {
      return row.categoryId !== "c_sal";
    }));
    eq("suggest.fixedFlagged", sg.c_rent.fixed, true);
    eq("suggest.fixedIncluded", sg.c_rent.suggested, 1800000);
    eq("suggest.confidenceHigh", sg.c_groc.confidence, "high");
    eq("suggest.confidenceMedium", sg.c_rent.confidence, "medium");
    eq("suggest.confidenceLow", sg.c_fun.confidence, "low");
    eq("suggest.monthsSeen", sg.c_rent.monthsSeen, 2);
    eq("suggest.perPeriod", sg.c_groc.perPeriod["2026-08"], 900000);
    ok("suggest.halfPeriodExcluded", sg.c_groc.perPeriod["2026-09"] === undefined);
    eq("suggest.order", suggestion.rows[0].categoryId, "c_rent");
    eq("suggest.deterministic",
      JSON.stringify(suggestLimits()), JSON.stringify(suggestLimits()));

    /* 14b — nothing but the period in progress: no basis, no suggestion. */
    scene("2026-09-21", { entries: [entry("g1", "2026-09-05", 400000, "c_groc")] });
    var empty = suggestLimits();
    eq("suggest.noBasis.rows", empty.rows.length, 0);
    eq("suggest.noBasis.complete", empty.basis.complete, false);
    eq("suggest.noBasis.periods", empty.basis.periods.length, 0);

    /* 14c — at most the last six complete periods. */
    var deep = [];
    ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
      .forEach(function (key, index) {
        deep.push(entry("d" + index, key + "-08", 100000 + index * 1000, "c_groc"));
      });
    scene("2026-09-21", { entries: deep });
    var windowed = suggestLimits();
    eq("suggest.window", windowed.basis.periods.length, 6);
    eq("suggest.windowOldest", windowed.basis.periods[0], "2026-03");
    eq("suggest.windowNewest", windowed.basis.periods[5], "2026-08");

    /* 14d — applying the ticked rows: one write, income refused, last wins. */
    st = scene("2026-09-21", {
      limits: [{ id: "l1", categoryId: "c_groc", amount: 600000 }],
      entries: [
        entry("g1", "2026-06-10", 100000, "c_groc"),
        entry("g2", "2026-07-12", 148700, "c_groc"),
        entry("g3", "2026-08-14", 900000, "c_groc")
      ]
    });
    var picked = suggestLimits().rows;
    eq("apply.pickedRows", picked.length, 1);
    writeCount = 0;
    eq("apply.count", applyLimitSuggestions(picked.concat([
      { categoryId: "c_sal", suggested: 100 },      /* income: never applied */
      { categoryId: "c_missing", suggested: 100 },   /* no such category */
      { categoryId: "c_fun", suggested: 25000 },
      { categoryId: "c_fun", suggested: 30000 }      /* same category twice */
    ])), 2);
    eq("apply.singleWrite", writeCount, 1);

    function limitOf(categoryId) {
      var found = null;
      st.limits.forEach(function (row) { if (row.categoryId === categoryId) found = row.amount; });
      return found;
    }
    eq("apply.replaced", limitOf("c_groc"), 150000);
    eq("apply.lastWins", limitOf("c_fun"), 30000);
    eq("apply.incomeSkipped", limitOf("c_sal"), null);
    eq("apply.limitCount", st.limits.length, 2);
    eq("apply.emptyInput", applyLimitSuggestions([]), 0);
    eq("apply.emptyNoWrite", writeCount, 1);

    /* --------------------------------------- 15 — recurring detection */

    function byDetectionKey(rowList) {
      var map = Object.create(null);
      rowList.forEach(function (row) { map[row.key] = row; });
      return map;
    }

    scene("2026-09-21", {
      entries: [
        entry("s1", "2026-07-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s2", "2026-08-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s3", "2026-09-15", 6999, "c_fun", { note: "Spotify" }),
        /* two coffees inside ONE period are a week, not a subscription */
        entry("k1", "2026-08-03", 5000, "c_groc", { note: "Kahve" }),
        entry("k2", "2026-08-20", 5000, "c_groc", { note: "Kahve" }),
        /* income repeats too */
        entry("m1", "2026-07-25", 4200000, "c_sal", { note: "Maas", direction: "in" }),
        entry("m2", "2026-08-25", 4200000, "c_sal", { note: "Maas", direction: "in" }),
        /* 10.000 vs 13.000: inside the 25% grouping band, past the 10% variance */
        entry("v1", "2026-07-10", 10000, "c_trans", { note: "Elektrik" }),
        entry("v2", "2026-08-10", 13000, "c_trans", { note: "Elektrik" }),
        entry("i1", "2026-07-18", 10000, "c_trans", { note: "Fiber" }),
        entry("i2", "2026-08-18", 10500, "c_trans", { note: "Fiber" }),
        /* the third one is ten times the median: dropped, not averaged in */
        entry("o1", "2026-06-05", 10000, "c_groc", { note: "Market haftalik" }),
        entry("o2", "2026-07-05", 10000, "c_groc", { note: "Market haftalik" }),
        entry("o3", "2026-08-05", 100000, "c_groc", { note: "Market haftalik" }),
        /* no note: no stable identity, no suggestion */
        entry("n1", "2026-07-07", 3000, "c_groc", { note: "" }),
        entry("n2", "2026-08-07", 3000, "c_groc", { note: "" }),
        /* a category that no longer exists cannot carry a rule */
        entry("x1", "2026-07-09", 4000, "c_missing", { note: "Hayalet" }),
        entry("x2", "2026-08-09", 4000, "c_missing", { note: "Hayalet" })
      ]
    });
    var detected = detectRecurring();
    var dk = byDetectionKey(detected);
    eq("detect.count", detected.length, 5);
    eq("detect.order", detected[0].key, "c_fun|out|spotify");
    eq("detect.periods", dk["c_fun|out|spotify"].periods.join(","),
      "2026-07,2026-08,2026-09");
    eq("detect.amount", dk["c_fun|out|spotify"].amount, 6999);
    eq("detect.dayOfMonth", dk["c_fun|out|spotify"].dayOfMonth, 15);
    eq("detect.name", dk["c_fun|out|spotify"].name, "Spotify");
    eq("detect.steady", dk["c_fun|out|spotify"].amountVaries, false);
    eq("detect.occurrences", dk["c_fun|out|spotify"].occurrences.length, 3);
    eq("detect.noRuleYet", dk["c_fun|out|spotify"].existingRuleId, null);
    eq("detect.notFixed", dk["c_fun|out|spotify"].alreadyFixed, false);
    ok("detect.sameMonthIgnored", dk["c_groc|out|kahve"] === undefined);
    ok("detect.noteless", detected.every(function (row) { return !!row.name; }));
    ok("detect.unknownCategory", detected.every(function (row) {
      return row.categoryId !== "c_missing";
    }));
    eq("detect.income", dk["c_sal|in|maas"].direction, "in");
    eq("detect.incomeAmount", dk["c_sal|in|maas"].amount, 4200000);
    eq("detect.varies", dk["c_trans|out|elektrik"].amountVaries, true);
    eq("detect.variesAmount", dk["c_trans|out|elektrik"].amount, 11500);
    eq("detect.withinVariance", dk["c_trans|out|fiber"].amountVaries, false);
    eq("detect.outlierDropped", dk["c_groc|out|markethaftalik"].occurrences.length, 2);
    eq("detect.outlierMedian", dk["c_groc|out|markethaftalik"].amount, 10000);
    eq("detect.deterministic",
      JSON.stringify(detectRecurring()), JSON.stringify(detectRecurring()));

    /* 15b — a payment that already has a rule is reported, flagged, so the UI
             can hide it instead of offering a second copy. */
    scene("2026-09-21", {
      recurring: [{ id: "r1", name: "Spotify", amount: 6999, direction: "out",
        categoryId: "c_fun", dayOfMonth: 15, fixed: false, startDate: "2026-01-15",
        endDate: null, active: true, lastGeneratedPeriod: "2026-09" }],
      entries: [
        entry("s1", "2026-07-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s2", "2026-08-15", 6999, "c_fun", { note: "Spotify" })
      ]
    });
    eq("detect.existingRule", detectRecurring()[0].existingRuleId, "r1");

    /* 15c — promotion writes no history: the occurrences are already here. */
    st = scene("2026-09-21", {
      entries: [
        entry("s1", "2026-07-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s2", "2026-08-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s3", "2026-09-15", 6999, "c_fun", { note: "Spotify" })
      ]
    });
    var found = detectRecurring()[0];
    writeCount = 0;
    var promoted = promoteToRecurring(found, { fixed: true });
    ok("promote.id", !!promoted.recurringId);
    eq("promote.singleWrite", writeCount, 1);
    eq("promote.markedFixed", promoted.markedFixed, 3);
    eq("promote.ruleCount", st.recurring.length, 1);
    eq("promote.stamp", st.recurring[0].lastGeneratedPeriod, "2026-09");
    eq("promote.startDate", st.recurring[0].startDate, "2026-07-15");
    eq("promote.dayOfMonth", st.recurring[0].dayOfMonth, 15);
    eq("promote.ruleFixed", st.recurring[0].fixed, true);
    eq("promote.noBackfill", generateRecurring("2026-09"), 0);
    eq("promote.entriesUntouched", st.entries.length, 3);
    ok("promote.occurrencesFixed", st.entries.every(function (e) { return e.fixed === true; }));
    /* but the rule does work from the next period on */
    eq("promote.nextPeriod", generateRecurring("2026-10"), 1);
    eq("promote.nextDate", st.entries[3].date, "2026-10-15");

    /* 15d — marking the category fixed carries its records across. */
    st = scene("2026-09-21", {
      entries: [
        entry("s1", "2026-07-15", 6999, "c_fun", { note: "Spotify" }),
        entry("s2", "2026-08-15", 6999, "c_fun", { note: "Spotify" }),
        entry("p1", "2026-08-02", 12000, "c_fun", { note: "Sinema" })
      ]
    });
    var marked = promoteToRecurring(detectRecurring()[0], { markCategoryFixed: true });
    eq("promote.categoryCarries", marked.markedFixed, 3);
    ok("promote.categoryFixed", st.categories.some(function (cat) {
      return cat.id === "c_fun" && cat.fixed === true;
    }));
    ok("promote.allFixed", st.entries.every(function (e) { return e.fixed === true; }));
    eq("promote.ruleFollowsCategory", st.recurring[0].fixed, true);

    /* 15e — a detection that cannot become a rule is refused, not guessed. */
    st = scene("2026-09-21", {});
    writeCount = 0;
    eq("promote.noDetection", promoteToRecurring(null, {}).recurringId, null);
    eq("promote.badCategory",
      promoteToRecurring({ categoryId: "c_missing", name: "X", amount: 100,
        direction: "out", dayOfMonth: 5, occurrences: [] }, {}).recurringId, null);
    eq("promote.zeroAmount",
      promoteToRecurring({ categoryId: "c_fun", name: "X", amount: 0,
        direction: "out", dayOfMonth: 5, occurrences: [] }, {}).recurringId, null);
    eq("promote.refusedNoWrite", writeCount, 0);
    eq("promote.refusedRuleCount", st.recurring.length, 0);

    /* ------------------------------------- 16 — accounts and holdings */

    function account(id, name, kind, opening) {
      return { id: id, name: name, kind: kind, opening: opening, currency: "TRY",
        color: "#8AA6FF", icon: "🏦", archived: false, createdAt: "2026-09-01" };
    }

    function holding(id, kind, quantity, unitCost, unitPrice, history) {
      return { id: id, name: id, kind: kind, quantity: quantity, unitCost: unitCost,
        unitPrice: unitPrice, priceDate: "2026-09-21", currency: "TRY", note: "",
        color: "#8AA6FF", icon: "📈", archived: false, createdAt: "2026-09-01",
        history: history || [] };
    }

    function openDebt(id, amount, dir) {
      return { id: id, person: id, amount: amount, direction: dir, date: "2026-09-10",
        dueDate: null, settled: false, settledDate: null, note: "" };
    }

    /* 16a — opening plus income minus expense. An entry with no account stays
             out of every balance, which is what makes the account optional. */
    st = scene("2026-09-21", {
      accounts: [account("a_bank", "Garanti", "bank", 500000),
        account("a_card", "Kart", "card", -250000)],
      entries: [
        entry("e1", "2026-09-05", 120000, "c_groc", { accountId: "a_bank" }),
        entry("e2", "2026-09-06", 4200000, "c_sal", { accountId: "a_bank", direction: "in" }),
        entry("e3", "2026-09-07", 30000, "c_fun", { accountId: "a_card" }),
        entry("e4", "2026-09-08", 9999, "c_groc", null)
      ]
    });
    eq("account.balance", accountBalance("a_bank"), 4580000);
    /* A card opens the month owing money and the sign survives the sum. */
    eq("account.cardBalance", accountBalance("a_card"), -280000);
    eq("account.unknown", accountBalance("a_nope"), 0);
    eq("account.total", accountTotals().total, 4300000);
    eq("account.count", accountTotals().count, 2);
    eq("account.byKindBank", accountTotals().byKind.bank, 4580000);
    eq("account.byKindCard", accountTotals().byKind.card, -280000);

    var flow = accountFlow("a_bank", "2026-09");
    eq("account.flowIn", flow.in, 4200000);
    eq("account.flowOut", flow.out, 120000);
    eq("account.flowCount", flow.count, 2);
    eq("account.flowQuietPeriod", accountFlow("a_card", "2026-08").count, 0);

    st = scene("2026-09-21", {
      accounts: [account("a_bank", "Garanti", "bank", 100000),
        { id: "a_old", name: "Kapali", kind: "cash", opening: 700000, currency: "TRY",
          color: "#8AA6FF", icon: "👛", archived: true, createdAt: "2026-01-01" }]
    });
    eq("account.archivedHidden", accounts().length, 1);
    eq("account.archivedListed", accounts({ all: true }).length, 2);
    /* The total above the cards has to be the sum of the cards under it. */
    eq("account.archivedOutOfTotal", accountTotals().total, 100000);

    /* 16b — the load-bearing one: deleting an account costs the reader the link
             and never an entry. */
    st = scene("2026-09-21", {
      accounts: [account("a_bank", "Garanti", "bank", 500000)],
      entries: [
        entry("e1", "2026-09-05", 120000, "c_groc", { accountId: "a_bank" }),
        entry("e2", "2026-09-06", 30000, "c_fun", { accountId: "a_bank" }),
        entry("e3", "2026-09-07", 9999, "c_groc", { accountId: null })
      ]
    });
    var detachment = removeAccount("a_bank");
    eq("account.removedName", detachment.record.name, "Garanti");
    eq("account.removedDetached", detachment.detached, 2);
    eq("account.removedGone", st.accounts.length, 0);
    eq("account.entriesKept", st.entries.length, 3);
    ok("account.entriesDetached", st.entries.every(function (e) {
      return e.accountId === null;
    }));
    eq("account.entryAmountKept", st.entries[0].amount, 120000);
    eq("account.entryDateKept", st.entries[0].date, "2026-09-05");
    eq("account.removeMissing", removeAccount("a_nope"), null);

    st = scene("2026-09-21", {});
    var accountId = addAccount({ name: "  Nakit  ", kind: "cash", opening: -1500 });
    ok("account.added", !!accountId);
    eq("account.nameTrimmed", st.accounts[0].name, "Nakit");
    eq("account.openingSignKept", st.accounts[0].opening, -1500);
    eq("account.createdAt", st.accounts[0].createdAt, "2026-09-21");
    ok("account.dressed", !!st.accounts[0].icon);
    addAccount({ name: "Hayali", kind: "crypto" });
    eq("account.unlistedKindDefaults", st.accounts[1].kind, "cash");
    eq("account.nameless", addAccount({ name: "   " }), null);
    eq("account.namelessKey", validateAccount({ name: "" }).errors.name, "err.nameRequired");
    eq("account.unreadableOpening", addAccount({ name: "X", opening: "bes lira" }), null);
    ok("account.updated", !!updateAccount(accountId, { name: "Cuzdan", kind: "savings" }));
    eq("account.updatedName", st.accounts[0].name, "Cuzdan");
    eq("account.updatedKind", st.accounts[0].kind, "savings");
    eq("account.updateMissing", updateAccount("a_nope", { name: "X" }), null);

    /* An account only reaches a balance if the entry write path carries it, so
       the shape the model writes is checked here rather than assumed. */
    st = scene("2026-09-21", {
      accounts: [account("a_bank", "Garanti", "bank", 0), account("a_card", "Kart", "card", 0)]
    });
    var attached = addEntry({ date: "2026-09-10", amount: 50000, direction: "out",
      categoryId: "c_groc", accountId: "a_bank" });
    ok("entry.written", !!attached);
    eq("entry.accountStored", st.entries[0].accountId, "a_bank");
    eq("entry.accountCounted", accountBalance("a_bank"), -50000);
    updateEntry(attached, { accountId: "a_card" });
    eq("entry.accountMoved", st.entries[0].accountId, "a_card");
    eq("entry.movedOffBank", accountBalance("a_bank"), 0);
    eq("entry.movedOntoCard", accountBalance("a_card"), -50000);
    updateEntry(attached, { accountId: null });
    eq("entry.accountCleared", st.entries[0].accountId, null);
    addEntry({ date: "2026-09-11", amount: 100, direction: "out", categoryId: "c_groc" });
    eq("entry.unattachedByDefault", st.entries[1].accountId, null);
    /* The entry still counts everywhere it counted before accounts existed. */
    eq("entry.stillSpending", periodSummary("2026-09").spentTotal, 50100);

    /* 16c — §3.3's arithmetic. Quantity carries four implied decimals, so half
             a unit is 5000, and each product is rounded exactly once. */
    scene("2026-09-21", {
      investments: [
        holding("i_btc", "crypto", 5000, 180000000, 240000000),
        holding("i_thy", "stock", 1000000, 24500, 31200),
        holding("i_fund", "fund", 30000, 500000, 450000)
      ]
    });
    var half = investmentValue(investmentById("i_btc"));
    eq("holding.halfUnitValue", half.value, 120000000);
    eq("holding.halfUnitCost", half.cost, 90000000);
    eq("holding.halfUnitGain", half.gain, 30000000);
    eq("holding.halfUnitPct", half.gainRatio, 33);

    var shares = investmentValue(investmentById("i_thy"));
    eq("holding.value", shares.value, 3120000);
    eq("holding.cost", shares.cost, 2450000);
    eq("holding.gainPct", shares.gainRatio, 27);

    /* A loss is a negative gain and a negative percentage, never a magnitude
       the view has to work the sign of out for itself. */
    var losing = investmentValue(investmentById("i_fund"));
    eq("holding.lossValue", losing.value, 1350000);
    eq("holding.lossGain", losing.gain, -150000);
    eq("holding.lossPct", losing.gainRatio, -10);
    ok("holding.uncostedPct",
      investmentValue(holding("i_x", "other", 10000, 0, 5000)).gainRatio === null);

    var portfolio = investmentTotals();
    eq("holding.totalValue", portfolio.value, 124470000);
    eq("holding.totalCost", portfolio.cost, 93950000);
    eq("holding.totalGain", portfolio.gain, 30520000);
    eq("holding.totalCount", portfolio.count, 3);
    eq("holding.byKind", portfolio.byKind.crypto.value, 120000000);
    eq("holding.kindsWidestFirst", portfolio.kinds[0].kind, "crypto");
    eq("holding.kindShare", portfolio.kinds[0].share, pct(120000000, 124470000));

    /* 16d — a price is a price on a day, and a second edit on the same day is a
             correction of that day rather than a second reading. */
    st = scene("2026-09-21", {
      investments: [holding("i_thy", "stock", 1000000, 24500, 24500,
        [{ date: "2026-09-02", unitPrice: 24500 }])]
    });
    ok("price.set", !!setInvestmentPrice("i_thy", 31200, "2026-09-21"));
    eq("price.appended", st.investments[0].history.length, 2);
    eq("price.current", st.investments[0].unitPrice, 31200);
    eq("price.currentDate", st.investments[0].priceDate, "2026-09-21");
    ok("price.again", !!setInvestmentPrice("i_thy", 30500, "2026-09-21"));
    eq("price.replacedCount", st.investments[0].history.length, 2);
    eq("price.replacedValue", st.investments[0].history[1].unitPrice, 30500);
    /* A price filled in for an earlier day slots into place and does not become
       the price the holding is read at today. */
    setInvestmentPrice("i_thy", 20000, "2026-08-15");
    eq("price.oldestFirst",
      st.investments[0].history.map(function (p) { return p.date; }).join(","),
      "2026-08-15,2026-09-02,2026-09-21");
    eq("price.newestStillCurrent", st.investments[0].unitPrice, 30500);
    eq("price.newestDateStillCurrent", st.investments[0].priceDate, "2026-09-21");
    eq("price.missingHolding", setInvestmentPrice("i_nope", 100, "2026-09-21"), null);
    eq("price.unreadable", setInvestmentPrice("i_thy", "bedava", "2026-09-21"), null);

    st = scene("2026-09-21", { investments: [holding("i_many", "gold", 10000, 1000, 1000, [])] });
    var ceiling = storeCap("HISTORY_MAX", 400);
    st.investments[0].history = dates().eachDay("2025-06-01", "2026-09-20")
      .map(function (day, index) { return { date: day, unitPrice: 1000 + index }; });
    setInvestmentPrice("i_many", 9999, "2026-09-21");
    eq("price.capped", st.investments[0].history.length, ceiling);
    eq("price.cappedNewest", st.investments[0].history[ceiling - 1].unitPrice, 9999);
    ok("price.cappedOldestDropped", st.investments[0].history[0].date > "2025-06-01");

    /* 16e — the add row writes the opening history row itself, because the
             store does not invent one and §5.2's chart needs the first price. */
    st = scene("2026-09-21", {});
    var holdingId = addInvestment({ name: "THYAO", kind: "stock", quantity: 1000000,
      unitCost: 24500, unitPrice: 31200 });
    ok("holding.added", !!holdingId);
    eq("holding.openingRows", st.investments[0].history.length, 1);
    eq("holding.openingRowDate", st.investments[0].history[0].date, "2026-09-21");
    eq("holding.openingRowPrice", st.investments[0].history[0].unitPrice, 31200);
    eq("holding.priceDate", st.investments[0].priceDate, "2026-09-21");
    addInvestment({ name: "Tarla", kind: "field", quantity: 10000, unitPrice: 100 });
    eq("holding.unlistedKindDefaults", st.investments[1].kind, "other");
    eq("holding.nameless", addInvestment({ name: "", quantity: 10000, unitPrice: 100 }), null);
    eq("holding.priceRequiredKey",
      validateInvestment({ name: "X", quantity: 10000 }).errors.unitPrice, "err.priceRequired");
    eq("holding.fractionalQuantity",
      validateInvestment({ name: "X", quantity: 0.5, unitPrice: 100 }).errors.quantity,
      "err.quantityInvalid");
    eq("holding.negativeQuantity",
      validateInvestment({ name: "X", quantity: -10000, unitPrice: 100 }).errors.quantity,
      "err.quantityInvalid");
    ok("holding.zeroQuantityKept",
      validateInvestment({ name: "X", quantity: 0, unitPrice: 100 }).ok);
    eq("holding.removedRecord", (removeInvestment(holdingId) || {}).name, "THYAO");
    eq("holding.removeMissing", removeInvestment("i_nope"), null);

    /* 16f — one point per date that carries a price, oldest first, every
             holding read at the newest price typed on or before it. */
    scene("2026-09-21", {
      investments: [
        holding("i_a", "stock", 10000, 1000, 3000, [
          { date: "2026-07-01", unitPrice: 1000 },
          { date: "2026-09-01", unitPrice: 3000 }
        ]),
        holding("i_b", "gold", 20000, 5000, 6000, [
          { date: "2026-08-01", unitPrice: 5000 },
          { date: "2026-09-01", unitPrice: 6000 }
        ])
      ]
    });
    var series = investmentSeries(12);
    eq("series.points", series.length, 3);
    eq("series.oldestFirst", series.map(function (p) { return p.date; }).join(","),
      "2026-07-01,2026-08-01,2026-09-01");
    /* Before its first price the gold counts as nothing, not as its cost. */
    eq("series.firstPoint", series[0].value, 1000);
    eq("series.secondPoint", series[1].value, 11000);
    eq("series.thirdPoint", series[2].value, 15000);
    eq("series.window", investmentSeries(2).length, 2);
    eq("series.deterministic",
      JSON.stringify(investmentSeries(12)), JSON.stringify(investmentSeries(12)));

    scene("2026-09-21", {});
    eq("series.noHoldings", investmentSeries(12).length, 0);

    /* 16g — net worth across all four parts. A settled debt is closed and sits
             on neither side of the reading. */
    scene("2026-09-21", {
      accounts: [account("a_bank", "Garanti", "bank", 500000),
        account("a_card", "Kart", "card", -250000)],
      investments: [holding("i_thy", "stock", 1000000, 24500, 31200)],
      entries: [entry("e1", "2026-09-05", 100000, "c_groc", { accountId: "a_bank" })],
      debts: [openDebt("d1", 75000, "owedToMe"), openDebt("d2", 300000, "iOwe"),
        { id: "d3", person: "Eski", amount: 999999, direction: "iOwe", date: "2026-01-01",
          dueDate: null, settled: true, settledDate: "2026-02-01", note: "" }]
    });
    var worth = netWorth();
    eq("networth.cash", worth.cash, 150000);
    eq("networth.investments", worth.investments, 3120000);
    eq("networth.owedToMe", worth.owedToMe, 75000);
    eq("networth.iOwe", worth.iOwe, 300000);
    eq("networth.assets", worth.assets, 3345000);
    eq("networth.liabilities", worth.liabilities, 300000);
    eq("networth.total", worth.total, 3045000);
    ok("networth.measured", worth.measured === true);
    eq("networth.openDebtsOnly", worth.counts.debts, 2);

    /* 16h — an empty store reads as zeros and says it measured nothing, so the
             view writes a sentence instead of printing a zero as a figure. */
    scene("2026-09-21", {});
    var blank = netWorth();
    eq("networth.emptyCash", blank.cash, 0);
    eq("networth.emptyInvestments", blank.investments, 0);
    eq("networth.emptyOwedToMe", blank.owedToMe, 0);
    eq("networth.emptyIOwe", blank.iOwe, 0);
    eq("networth.emptyAssets", blank.assets, 0);
    eq("networth.emptyLiabilities", blank.liabilities, 0);
    eq("networth.emptyTotal", blank.total, 0);
    ok("networth.emptyUnmeasured", blank.measured === false);
    eq("networth.emptyAccountTotal", accountTotals().total, 0);
    eq("networth.emptyHoldingValue", investmentTotals().value, 0);
    ok("networth.emptyGainRatio", investmentTotals().gainRatio === null);

    /* A file written before v2 carries neither collection, and every read has
       to answer rather than throw while the migration catches up. */
    st = scene("2026-09-21", {});
    delete st.accounts;
    delete st.investments;
    eq("networth.missingCollections", netWorth().total, 0);
    eq("account.missingCollection", accounts().length, 0);
    eq("series.missingCollection", investmentSeries(12).length, 0);

    fixtures = null;

    var report = { ok: failures.length === 0, checks: checks, failures: failures };
    if (global.console) {
      if (report.ok) global.console.log("Moon.Model selftest: " + checks + " checks, all clean");
      else global.console.error("Moon.Model selftest FAILED", failures);
    }
    return report;
  }

  Moon.Model._selftest = selftest;
})(window);
