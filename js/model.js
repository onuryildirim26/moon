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
    if (!text(d.categoryId)) errors.categoryId = "err.categoryRequired";
    else if (!categoryById(d.categoryId)) errors.categoryId = "err.categoryUnknown";
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

  var ENTRY_FIELDS = ["date", "amount", "direction", "categoryId", "note", "fixed",
    "source", "confirmed", "recurringId"];

  function updateEntry(id, patch) {
    if (!id || !patch) return null;
    var current = null;
    list("entries").forEach(function (e) { if (e && e.id === id) current = e; });
    if (!current) return null;

    var merged = util.clone(current);
    ENTRY_FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
    });
    if (!validateEntry(merged).ok) return null;
    merged.amount = positiveInt(merged.amount);
    merged.note = text(merged.note).slice(0, 200);

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

      var targetId = fallbackCategoryId(draft);
      if (targetId === id) return null;

      /* No entry is ever lost with its category: they move, they do not die. */
      var movedEntries = 0;
      bucket(draft, "entries").forEach(function (e) {
        if (e && e.categoryId === id) {
          e.categoryId = targetId;
          movedEntries += 1;
        }
      });

      var movedRecurring = 0;
      bucket(draft, "recurring").forEach(function (r) {
        if (r && r.categoryId === id) {
          r.categoryId = targetId;
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

  function setLimit(categoryId, minor) {
    if (!categoryId) return null;
    var amount = minor === null || minor === undefined ? null : positiveInt(minor);
    return write("limit:set", function (draft) {
      var limits = bucket(draft, "limits");
      for (var i = limits.length - 1; i >= 0; i -= 1) {
        if (!limits[i] || limits[i].categoryId !== categoryId) continue;
        if (amount === null || amount === 0) {
          limits.splice(i, 1);
          return null;
        }
        limits[i].amount = amount;
        return limits[i].id;
      }
      if (amount === null || amount === 0) return null;
      var record = { id: util.id("l"), categoryId: categoryId, amount: amount };
      limits.push(record);
      return record.id;
    });
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
          return id;
        }
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
    goalProgress: goalProgress,
    debtTotals: debtTotals,

    validateEntry: validateEntry,
    validateLimit: validateLimit,
    validateRecurring: validateRecurring,
    validateGoal: validateGoal,
    validateDebt: validateDebt,

    addEntry: addEntry,
    addEntries: addEntries,
    updateEntry: updateEntry,
    removeEntry: removeEntry,
    removeEntries: removeEntries,
    confirmEntries: confirmEntries,

    addCategory: addCategory,
    updateCategory: updateCategory,
    removeCategory: removeCategory,
    setLimit: setLimit,

    addRecurring: addRecurring,
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
        debts: []
      };
      var st = util.clone(base);
      if (overrides) Object.keys(overrides).forEach(function (key) { st[key] = overrides[key]; });
      fixtures = {
        Dates: fixtureDates(today),
        Money: { pct: function (part, whole) { return whole ? Math.round((part / whole) * 100) : null; } },
        Store: {
          state: st,
          update: function (mutator) { mutator(st); }
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

    /* 12 — duplicate fingerprint shape. */
    scene("2026-09-21", {});
    eq("duplicateKey",
      duplicateKey({ date: "2026-09-26", amount: 24890, direction: "out", note: "A101 haftalık alisveris" }),
      "2026-09-26|24890|out|a101haftalıkalisveris");
    eq("duplicateKey.noteCap",
      duplicateKey({ date: "2026-09-26", amount: 100, direction: "out",
        note: "bir cok uzun aciklama daha da uzun" }).split("|")[3].length, 24);

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
