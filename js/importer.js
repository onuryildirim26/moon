/* Moon — importer: a parsed table becomes entry drafts.
 *
 * csv.js answers "what are the cells". This file answers the harder question,
 * "what do the columns mean", and it is allowed to be wrong: every guess is
 * shown in the wizard and can be overridden. So the rules here are written to
 * fail loudly (a rejected row with a reason) rather than quietly (a wrong
 * amount the reader discovers three months later).
 *
 * Contract: 02-sozlesme.md §9. Reads Moon.CSV, Moon.Money, Moon.Dates,
 * Moon.Model — all resolved inside function bodies, never at load time.
 *
 * Two rules earn their own note:
 *  - Balance columns are eliminated, never used as amounts. A balance looks
 *    exactly like an amount to a naive scorer and is the classic import bug.
 *  - Duplicates are counted, not matched. Two real coffees on the same day for
 *    the same amount must both import; the same file imported twice must not.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var MAX_ROWS = 50000;
  var NOTE_MAX = 200;              /* Model.validateEntry rejects longer notes */
  var SCORE_MIN = 0.7;             /* content guessing needs a clear majority  */
  var MONO_MIN = 0.85;             /* monotone share that marks a balance      */
  var SAMPLE_ROWS = 200;           /* scoring reads a sample, not 50k rows     */

  /* Header dictionaries. Keys are folded (lowercase, diacritics removed,
     punctuation and spaces dropped): "İşlem Tarihi" -> "islemtarihi". */
  var EXACT = {
    date: ["tarih", "islemtarihi", "islemtarih", "valor", "valortarihi", "valortarih",
      "kayittarihi", "tarihsaat", "islemzamani", "date", "transactiondate",
      "postingdate", "posteddate", "posted", "valuedate", "bookingdate",
      "effectivedate", "datetime", "trandate"],
    note: ["aciklama", "detay", "ayrinti", "aciklamadetay", "islemaciklamasi", "aciklamalar",
      "not", "description", "details", "detail", "memo", "narrative", "particulars",
      "note", "notes", "payee", "reference", "transactiondetails", "merchant"],
    amount: ["tutar", "miktar", "islemtutari", "tutartl", "tutartry", "amount", "value",
      "transactionamount", "amounttry", "netamount", "sum"],
    debit: ["borc", "cikan", "cikis", "gider", "harcama", "odenen", "borctutari",
      "debit", "debits", "withdrawal", "withdrawals", "moneyout", "paidout",
      "outflow", "debitamount"],
    credit: ["alacak", "giren", "giris", "gelir", "yatan", "alacaktutari",
      "credit", "credits", "deposit", "deposits", "moneyin", "paidin",
      "inflow", "creditamount"],
    balance: ["bakiye", "kalanbakiye", "guncelbakiye", "bakiyetutari", "balance",
      "runningbalance", "closingbalance", "availablebalance", "ledgerbalance"],
    category: ["kategori", "kategoriadi", "islemturu", "islemtipi", "islemtur", "tur", "tip",
      "category", "categories", "type", "transactiontype", "kind"]
  };

  /* Substring pass, in priority order: balance before amount so that
     "Bakiye Tutarı" is a balance, not an amount. */
  var STEMS = [
    ["date", ["tarih", "valor", "date"]],
    ["balance", ["bakiye", "balance"]],
    ["debit", ["borc", "cikan", "debit", "withdraw", "outflow"]],
    ["credit", ["alacak", "giren", "credit", "deposit", "inflow"]],
    ["category", ["kategori", "islemturu", "islemtipi", "category"]],
    ["amount", ["tutar", "miktar", "amount"]],
    ["note", ["aciklama", "detay", "ayrinti", "description", "detail", "memo", "payee", "narrative"]]
  ];

  var ROLE_KEYS = ["date", "note", "amount", "debit", "credit", "category", "balance"];

  function csv() { return Moon.CSV; }
  function money() { return Moon.Money; }
  function dates() { return Moon.Dates; }
  function model() { return Moon.Model; }

  function fold(value) {
    var engine = csv();
    if (engine && typeof engine._fold === "function") return engine._fold(value);
    return String(value === null || value === undefined ? "" : value)
      .toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function cell(row, index) {
    if (!row || index === null || index === undefined || index < 0) return "";
    var value = row[index];
    return value === null || value === undefined ? "" : String(value);
  }

  function tidy(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/\s+/g, " ").trim();
  }

  function roleFromHeader(header) {
    var key = fold(header);
    if (!key) return null;
    var role;
    for (var i = 0; i < ROLE_KEYS.length; i += 1) {
      role = ROLE_KEYS[i];
      if (EXACT[role].indexOf(key) !== -1) return role;
    }
    for (i = 0; i < STEMS.length; i += 1) {
      var stems = STEMS[i][1];
      for (var j = 0; j < stems.length; j += 1) {
        if (key.indexOf(stems[j]) !== -1) return STEMS[i][0];
      }
    }
    return null;
  }

  /* ------------------------------------------------------- value reading */

  /* The sign lives in the text, not in the number: Money.parse is documented
     to return the magnitude, so negativity is read here from the raw cell —
     leading or trailing minus, unicode minus, or accounting parentheses. */
  function rawNegative(text) {
    var trimmed = String(text).replace(/[\s  ]/g, "");
    if (/^\(.*\)$/.test(trimmed)) return true;
    if (/^[-−]/.test(trimmed)) return true;
    return /[-−]$/.test(trimmed);
  }

  function readAmount(text, decimal) {
    var raw = String(text === null || text === undefined ? "" : text);
    if (!/\d/.test(raw)) return { ok: false, minor: 0, negative: false };
    var engine = money();
    if (!engine || typeof engine.parse !== "function") return { ok: false, minor: 0, negative: false };
    var parsed;
    try {
      parsed = engine.parse(raw, { decimal: decimal || "auto" });
    } catch (e) {
      return { ok: false, minor: 0, negative: false };
    }
    if (!parsed || !parsed.ok) return { ok: false, minor: 0, negative: false };
    var minor = Number(parsed.minor);
    if (!isFinite(minor)) return { ok: false, minor: 0, negative: false };
    return {
      ok: true,
      minor: Math.abs(Math.round(minor)),
      negative: minor < 0 || rawNegative(raw)
    };
  }

  function readDate(text, order) {
    var engine = dates();
    if (!engine || typeof engine.parseFlexible !== "function") return null;
    var iso;
    try {
      iso = engine.parseFlexible(String(text === null || text === undefined ? "" : text),
        { order: order || "auto" });
    } catch (e) {
      return null;
    }
    return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }

  /* ---------------------------------------------------------- scoring ---- */

  function columnValues(rows, index) {
    var out = [];
    var limit = Math.min(rows.length, SAMPLE_ROWS);
    for (var i = 0; i < limit; i += 1) {
      out.push(cell(rows[i], index));
    }
    return out;
  }

  function filled(values) {
    return values.filter(function (value) {
      return /\S/.test(value);
    });
  }

  function dateRatio(values) {
    var pool = filled(values);
    if (!pool.length) return 0;
    var engine = dates();
    var shape = csv() && csv()._looksLikeDate;
    var hits = 0;
    pool.forEach(function (value) {
      if (engine && typeof engine.parseFlexible === "function") {
        if (readDate(value, "auto")) hits += 1;
      } else if (shape && shape(value)) {
        hits += 1;
      }
    });
    return hits / pool.length;
  }

  function moneyRatio(values) {
    var pool = filled(values);
    if (!pool.length) return 0;
    var hits = 0;
    pool.forEach(function (value) {
      if (readAmount(value, "auto").ok) hits += 1;
    });
    return hits / pool.length;
  }

  function textWeight(values) {
    var pool = filled(values);
    if (!pool.length) return 0;
    var total = 0;
    pool.forEach(function (value) {
      total += tidy(value).length;
    });
    return total / pool.length;
  }

  /* A running balance climbs or falls in one direction and dwarfs the amounts
     next to it. Both signals are reported; the caller weighs them. */
  function balanceShape(values) {
    var series = [];
    filled(values).forEach(function (value) {
      var read = readAmount(value, "auto");
      if (read.ok) series.push(read.negative ? -read.minor : read.minor);
    });
    if (series.length < 4) return { monotone: 0, median: 0, count: series.length };

    var up = 0;
    var down = 0;
    for (var i = 1; i < series.length; i += 1) {
      if (series[i] >= series[i - 1]) up += 1; else down += 1;
    }
    var sorted = series.map(Math.abs).sort(function (a, b) { return a - b; });
    return {
      monotone: Math.max(up, down) / (series.length - 1),
      median: sorted[Math.floor(sorted.length / 2)],
      count: series.length
    };
  }

  function guessOrder(values, opts) {
    var engine = dates();
    var samples = filled(values).slice(0, 40);
    if (engine && typeof engine.guessOrder === "function") {
      try {
        var order = engine.guessOrder(samples);
        if (order === "dmy" || order === "mdy") return order;
      } catch (e) { /* fall through to the local read */ }
    }
    for (var i = 0; i < samples.length; i += 1) {
      var match = /^\s*(\d{1,4})[.\/\-](\d{1,2})[.\/\-](\d{1,4})/.exec(samples[i]);
      if (!match) continue;
      if (Number(match[1]) > 31) return "dmy";          /* ISO: order is moot */
      if (Number(match[1]) > 12) return "dmy";
      if (Number(match[2]) > 12) return "mdy";
    }
    /* Undecidable. A comma-separated file is usually a US export. */
    return opts && opts.delimiter === "," ? "mdy" : "dmy";
  }

  /* ------------------------------------------------------------- roles --- */

  function guessRoles(headers, rows, opts) {
    opts = opts || {};
    headers = Array.isArray(headers) ? headers : [];
    rows = Array.isArray(rows) ? rows : [];

    var width = headers.length;
    rows.forEach(function (row) {
      if (Array.isArray(row) && row.length > width) width = row.length;
    });

    var columns = [];
    var claimed = [];
    var dateScores = [];
    var moneyScores = [];
    var weights = [];
    var i;

    for (i = 0; i < width; i += 1) {
      columns.push(columnValues(rows, i));
      claimed.push(roleFromHeader(headers[i]));
      dateScores.push(dateRatio(columns[i]));
      moneyScores.push(moneyRatio(columns[i]));
      weights.push(textWeight(columns[i]));
    }

    var out = {
      date: null, note: null, amount: null, debit: null, credit: null,
      category: null, balance: null,
      dateOrder: "dmy", decimal: ",", signRule: "negativeIsExpense",
      scores: { date: 0, amount: 0 }, guessedFromContent: []
    };
    if (!width) return out;

    function claims(role) {
      var list = [];
      for (var c = 0; c < width; c += 1) {
        if (claimed[c] === role) list.push(c);
      }
      return list;
    }

    function bestBy(list, score) {
      var best = null;
      list.forEach(function (index) {
        if (best === null || score[index] > score[best] + 1e-9) best = index;
      });
      return best;
    }

    /* date — header first, content as the tie-breaker and the fallback. */
    var dateClaims = claims("date");
    if (dateClaims.length) {
      out.date = bestBy(dateClaims, dateScores);
      if (dateScores[out.date] < SCORE_MIN) {
        /* The header says date but the cells disagree; believe the cells. */
        var better = bestBy(range(width), dateScores);
        if (better !== null && dateScores[better] >= SCORE_MIN) {
          out.date = better;
          out.guessedFromContent.push("date");
        }
      }
    } else {
      var dateGuess = bestBy(range(width), dateScores);
      if (dateGuess !== null && dateScores[dateGuess] >= SCORE_MIN) {
        out.date = dateGuess;
        out.guessedFromContent.push("date");
      }
    }
    out.scores.date = out.date === null ? 0 : dateScores[out.date];

    /* debit / credit — header only: no content test can tell them apart. */
    var debitClaims = claims("debit");
    var creditClaims = claims("credit");
    out.debit = debitClaims.length ? debitClaims[0] : null;
    out.credit = creditClaims.length ? creditClaims[0] : null;

    /* balance — named, or spotted by shape. Either way it is eliminated. */
    var balanceClaims = claims("balance");
    if (balanceClaims.length) out.balance = balanceClaims[0];

    /* amount */
    var amountClaims = claims("amount");
    if (amountClaims.length) {
      out.amount = bestBy(amountClaims, moneyScores);
    } else if (out.debit === null && out.credit === null) {
      var pool = range(width).filter(function (index) {
        return index !== out.date && index !== out.balance
          && claimed[index] !== "note" && claimed[index] !== "category"
          && moneyScores[index] >= SCORE_MIN;
      });
      if (pool.length) {
        var shapes = {};
        pool.forEach(function (index) { shapes[index] = balanceShape(columns[index]); });
        var flat = pool.filter(function (index) { return shapes[index].monotone < MONO_MIN; });
        if (flat.length && flat.length < pool.length) {
          /* A monotone money column beside a jumpy one is the balance. */
          pool.filter(function (index) { return flat.indexOf(index) === -1; })
            .forEach(function (index) {
              if (out.balance === null) out.balance = index;
            });
        }
        var candidates = flat.length ? flat : pool;
        candidates.sort(function (a, b) {
          var diff = shapes[a].median - shapes[b].median;   /* amounts < balances */
          return diff !== 0 ? diff : a - b;
        });
        out.amount = candidates[0];
        out.guessedFromContent.push("amount");
      }
    }
    if (out.amount !== null && out.amount === out.balance) out.balance = null;
    out.scores.amount = out.amount === null ? 0 : moneyScores[out.amount];

    /* note — header, else the wordiest column nobody else claimed. */
    var noteClaims = claims("note");
    if (noteClaims.length) {
      out.note = noteClaims[0];
    } else {
      var taken = [out.date, out.amount, out.debit, out.credit, out.balance];
      var noteBest = null;
      range(width).forEach(function (index) {
        if (taken.indexOf(index) !== -1) return;
        if (dateScores[index] >= SCORE_MIN || moneyScores[index] >= SCORE_MIN) return;
        if (weights[index] <= 0) return;
        if (noteBest === null || weights[index] > weights[noteBest]) noteBest = index;
      });
      if (noteBest !== null) {
        out.note = noteBest;
        out.guessedFromContent.push("note");
      }
    }

    /* category — header only. Guessing it from content mislabels money. */
    var categoryClaims = claims("category");
    if (categoryClaims.length && categoryClaims[0] !== out.note) out.category = categoryClaims[0];

    if (out.debit !== null && out.credit !== null) {
      out.signRule = "debitCredit";
    } else if (out.amount === null && (out.debit !== null || out.credit !== null)) {
      out.signRule = "debitCredit";
    } else {
      out.signRule = "negativeIsExpense";
    }

    out.dateOrder = guessOrder(out.date === null ? [] : columns[out.date], opts);

    var numeric = [];
    [out.amount, out.debit, out.credit].forEach(function (index) {
      if (index !== null && columns[index]) numeric = numeric.concat(columns[index]);
    });
    var engine = csv();
    var decimal = engine && typeof engine.detectDecimal === "function"
      ? engine.detectDecimal(numeric) : null;
    out.decimal = decimal || (opts.delimiter === ";" ? "," : (out.dateOrder === "mdy" ? "." : ","));

    return out;
  }

  function range(n) {
    var out = [];
    for (var i = 0; i < n; i += 1) out.push(i);
    return out;
  }

  /* -------------------------------------------------------------- build -- */

  function duplicateKeyOf(entry) {
    var engine = model();
    if (engine && typeof engine.duplicateKey === "function") {
      try {
        var key = engine.duplicateKey(entry);
        if (typeof key === "string" && key) return key;
      } catch (e) { /* fall through to the local fingerprint */ }
    }
    var note = Moon.util && typeof Moon.util.searchKey === "function"
      ? Moon.util.searchKey(entry.note || "") : String(entry.note || "").toLowerCase();
    return entry.date + "|" + entry.amount + "|" + entry.direction + "|" + note.slice(0, 24);
  }

  function categoryIndex() {
    var engine = model();
    var index = { byName: {}, fixed: {}, kind: {} };
    var list = [];
    if (engine && typeof engine.categories === "function") {
      try {
        list = engine.categories({ includeArchived: true }) || [];
      } catch (e) {
        list = [];
      }
    }
    list.forEach(function (category) {
      if (!category || !category.id) return;
      index.fixed[category.id] = !!category.fixed;
      index.kind[category.id] = category.kind || "expense";
      var key = Moon.util && typeof Moon.util.searchKey === "function"
        ? Moon.util.searchKey(category.name || "") : String(category.name || "").toLowerCase();
      if (key && !index.byName[key]) index.byName[key] = category.id;
    });
    return index;
  }

  function existingCounts() {
    var engine = model();
    var counts = {};
    var ids = {};
    var list = [];
    if (engine && typeof engine.entries === "function") {
      try {
        list = engine.entries({}) || [];
      } catch (e) {
        list = [];
      }
    }
    list.forEach(function (entry) {
      if (!entry || !entry.date) return;
      var key = duplicateKeyOf(entry);
      counts[key] = (counts[key] || 0) + 1;
      if (!ids[key]) ids[key] = [];
      ids[key].push(entry.id || null);
    });
    return { counts: counts, ids: ids };
  }

  function build(parsed, mapping, opts) {
    parsed = parsed || {};
    mapping = mapping || {};
    opts = opts || {};

    var rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    var lines = Array.isArray(parsed.rowLines) ? parsed.rowLines : null;
    var decimal = mapping.decimal === "," || mapping.decimal === "." ? mapping.decimal : "auto";
    var order = mapping.dateOrder === "mdy" ? "mdy" : (mapping.dateOrder === "dmy" ? "dmy" : "auto");
    var skipDuplicates = opts.skipDuplicates !== false;
    var monthStartDay = typeof opts.monthStartDay === "number" ? opts.monthStartDay : 1;

    var out = {
      drafts: [],
      draftLines: [],
      duplicates: [],
      rejected: [],
      summary: {
        total: rows.length, ok: 0, duplicate: 0, rejected: 0,
        dateRange: [null, null], sumIn: 0, sumOut: 0, periods: []
      },
      error: null
    };

    if (!rows.length) {
      out.error = "csv.empty";
      return out;
    }
    if (rows.length > MAX_ROWS) {
      out.error = "csv.tooManyRows";
      return out;
    }
    if (!money() || !dates()) {
      out.error = "csv.internal";
      return out;
    }
    if (mapping.date === null || mapping.date === undefined) {
      out.error = "csv.noDateColumn";
      return out;
    }
    var hasAmount = mapping.amount !== null && mapping.amount !== undefined;
    var hasPair = (mapping.debit !== null && mapping.debit !== undefined)
      || (mapping.credit !== null && mapping.credit !== undefined);
    if (!hasAmount && !hasPair) {
      out.error = "csv.noAmountColumn";
      return out;
    }

    var categories = categoryIndex();
    var existing = existingCounts();
    var seen = {};
    var periods = {};
    var defaultId = opts.defaultCategoryId || null;
    var dateEngine = dates();

    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var line = lines && typeof lines[i] === "number" ? lines[i] : i + 1;

      var dateText = cell(row, mapping.date);
      var iso = readDate(dateText, order);
      if (!iso) {
        out.rejected.push({ line: line, reason: "badDate", value: tidy(dateText).slice(0, 40) });
        continue;
      }

      var direction = null;
      var minor = 0;
      var amountText = "";

      if (mapping.signRule === "debitCredit") {
        var debitRead = readAmount(cell(row, mapping.debit), decimal);
        var creditRead = readAmount(cell(row, mapping.credit), decimal);
        var debitHas = debitRead.ok && debitRead.minor > 0;
        var creditHas = creditRead.ok && creditRead.minor > 0;

        if (debitHas && creditHas) {
          /* Both columns filled is not a transaction this app can express. */
          out.rejected.push({ line: line, reason: "badAmount", value: tidy(cell(row, mapping.debit)).slice(0, 40) });
          continue;
        }
        if (debitHas) {
          direction = "out";
          minor = debitRead.minor;
          amountText = cell(row, mapping.debit);
        } else if (creditHas) {
          direction = "in";
          minor = creditRead.minor;
          amountText = cell(row, mapping.credit);
        } else {
          amountText = cell(row, mapping.debit) || cell(row, mapping.credit);
          var anyDigit = /\d/.test(amountText);
          out.rejected.push({
            line: line,
            reason: anyDigit ? "zeroAmount" : "badAmount",
            value: tidy(amountText).slice(0, 40)
          });
          continue;
        }
      } else {
        amountText = cell(row, mapping.amount);
        var read = readAmount(amountText, decimal);
        if (!read.ok) {
          out.rejected.push({ line: line, reason: "badAmount", value: tidy(amountText).slice(0, 40) });
          continue;
        }
        if (read.minor === 0) {
          out.rejected.push({ line: line, reason: "zeroAmount", value: tidy(amountText).slice(0, 40) });
          continue;
        }
        direction = read.negative ? "out" : "in";
        minor = read.minor;
      }

      if (minor === 0) {
        out.rejected.push({ line: line, reason: "zeroAmount", value: tidy(amountText).slice(0, 40) });
        continue;
      }

      var note = tidy(cell(row, mapping.note)).slice(0, NOTE_MAX);

      var categoryId = null;
      if (mapping.category !== null && mapping.category !== undefined) {
        var label = Moon.util && typeof Moon.util.searchKey === "function"
          ? Moon.util.searchKey(cell(row, mapping.category)) : "";
        if (label && categories.byName[label]) categoryId = categories.byName[label];
      }
      if (!categoryId && defaultId) categoryId = defaultId;
      /* Model.validateEntry requires direction and category kind to agree, so a
         mismatched default is dropped rather than written into an invalid draft. */
      if (categoryId && categories.kind[categoryId]) {
        var wanted = direction === "in" ? "income" : "expense";
        if (categories.kind[categoryId] !== wanted) categoryId = null;
      }

      var draft = {
        date: iso,
        amount: minor,
        direction: direction,
        categoryId: categoryId,
        note: note,
        fixed: categoryId ? !!categories.fixed[categoryId] : false,
        source: "csv",
        confirmed: false,
        recurringId: null
      };

      /* Count-based duplicate rule: the Nth copy in this file is a duplicate
         only while the stored data already holds N copies. */
      var key = duplicateKeyOf(draft);
      var occurrence = (seen[key] || 0) + 1;
      seen[key] = occurrence;
      var stored = existing.counts[key] || 0;

      if (occurrence <= stored) {
        out.duplicates.push({
          draft: draft,
          existingId: (existing.ids[key] && existing.ids[key][occurrence - 1]) || null,
          line: line,
          inFile: false
        });
        out.summary.duplicate += 1;
        if (skipDuplicates) continue;
      } else if (occurrence > 1) {
        /* Repeated inside this one file: reported so the reader can look, but
           kept, because two identical real transactions do happen. */
        out.duplicates.push({ draft: draft, existingId: null, line: line, inFile: true });
        out.summary.duplicate += 1;
      }

      out.drafts.push(draft);
      out.draftLines.push(line);
      if (direction === "in") out.summary.sumIn += minor;
      else out.summary.sumOut += minor;

      if (out.summary.dateRange[0] === null || iso < out.summary.dateRange[0]) out.summary.dateRange[0] = iso;
      if (out.summary.dateRange[1] === null || iso > out.summary.dateRange[1]) out.summary.dateRange[1] = iso;

      if (dateEngine && typeof dateEngine.periodKey === "function") {
        try {
          var period = dateEngine.periodKey(iso, monthStartDay);
          if (period) periods[period] = true;
        } catch (e) { /* period grouping is a convenience, never a blocker */ }
      }
    }

    out.summary.ok = out.drafts.length;
    out.summary.rejected = out.rejected.length;
    out.summary.periods = Object.keys(periods).sort();
    return out;
  }

  Moon.Importer = {
    guessRoles: guessRoles,
    build: build
  };

  /* ------------------------------------------------------------- selftest */

  Moon.Importer._selftest = function () {
    var results = { total: 0, pass: 0, fail: 0, failures: [], skipped: false };
    if (!csv() || !money() || !dates()) {
      results.skipped = true;
      if (global.console) global.console.log("Moon.Importer selftest: skipped (Money/Dates/CSV absent)");
      return results;
    }

    function check(name, actual, expected) {
      results.total += 1;
      var a = JSON.stringify(actual);
      var b = JSON.stringify(expected);
      if (a === b) {
        results.pass += 1;
      } else {
        results.fail += 1;
        results.failures.push(name + ": got " + a + ", want " + b);
      }
    }

    function table(text) {
      var sniffed = csv().sniff(text);
      return csv().parse(text, { delimiter: sniffed.delimiter, headerRow: sniffed.headerRow });
    }

    /* 1 — Turkish headers: balance recognised and eliminated. */
    var tr = table("Tarih;Açıklama;Tutar;Bakiye\n"
      + "01.09.2026;MAAŞ;38.500,00;41.230,55\n"
      + "02.09.2026;KİRA;-14.000,00;27.230,55\n"
      + "03.09.2026;MARKET;-1.847,60;25.382,95\n");
    var trRoles = guessRoles(tr.headers, tr.rows, { delimiter: ";" });
    check("tr roles", [trRoles.date, trRoles.note, trRoles.amount, trRoles.balance], [0, 1, 2, 3]);
    check("tr signRule", trRoles.signRule, "negativeIsExpense");
    check("tr decimal", trRoles.decimal, ",");
    check("tr dateOrder", trRoles.dateOrder, "dmy");

    var trBuilt = build(tr, trRoles, { defaultCategoryId: null });
    check("tr drafts", trBuilt.drafts.length, 3);
    check("tr first draft", trBuilt.drafts[0], {
      date: "2026-09-01", amount: 3850000, direction: "in", categoryId: null,
      note: "MAAŞ", fixed: false, source: "csv", confirmed: false, recurringId: null
    });
    check("tr expense direction", trBuilt.drafts[1].direction, "out");
    check("tr expense amount", trBuilt.drafts[1].amount, 1400000);
    check("tr sums", [trBuilt.summary.sumIn, trBuilt.summary.sumOut], [3850000, 1584760]);
    check("tr range", trBuilt.summary.dateRange, ["2026-09-01", "2026-09-03"]);

    /* 2 — English debit/credit pair. */
    var en = table("Date,Description,Debit,Credit\n"
      + "2026-09-01,Monthly salary,,3200.00\n"
      + "2026-09-02,Rent,1150.00,\n");
    var enRoles = guessRoles(en.headers, en.rows, { delimiter: "," });
    check("en roles", [enRoles.date, enRoles.note, enRoles.debit, enRoles.credit], [0, 1, 2, 3]);
    check("en signRule", enRoles.signRule, "debitCredit");
    check("en decimal", enRoles.decimal, ".");
    var enBuilt = build(en, enRoles, {});
    check("en credit row", [enBuilt.drafts[0].direction, enBuilt.drafts[0].amount], ["in", 320000]);
    check("en debit row", [enBuilt.drafts[1].direction, enBuilt.drafts[1].amount], ["out", 115000]);

    /* 3 — unknown headers: roles come from content. */
    var blind = table("A;B;C\n01.02.2026;-12,50;kahve\n02.02.2026;-19,90;market\n"
      + "03.02.2026;-5,00;otobus\n04.02.2026;-7,25;simit\n");
    var blindRoles = guessRoles(blind.headers, blind.rows, { delimiter: ";" });
    check("blind date", blindRoles.date, 0);
    check("blind amount", blindRoles.amount, 1);
    check("blind note", blindRoles.note, 2);

    /* 4 — two money columns, no usable headers: the monotone one is a balance. */
    var twin = table("A;B;C;D\n"
      + "01.02.2026;-100,00;10.000,00;kahve\n"
      + "02.02.2026;-200,00;9.800,00;market\n"
      + "03.02.2026;-50,00;9.750,00;otobus\n"
      + "04.02.2026;-25,00;9.725,00;simit\n"
      + "05.02.2026;-75,00;9.650,00;kitap\n");
    var twinRoles = guessRoles(twin.headers, twin.rows, { delimiter: ";" });
    check("twin amount", twinRoles.amount, 1);
    check("twin balance", twinRoles.balance, 2);

    /* 5 — rejection reasons. */
    var bad = table("Tarih;Aciklama;Tutar\n"
      + "32.13.2026;bozuk tarih;-5,00\n"
      + "05.02.2026;sifir;0,00\n"
      + "06.02.2026;harf;abc\n"
      + "07.02.2026;iyi;-9,90\n");
    var badRoles = guessRoles(bad.headers, bad.rows, { delimiter: ";" });
    var badBuilt = build(bad, badRoles, {});
    check("bad drafts", badBuilt.drafts.length, 1);
    check("bad reasons", badBuilt.rejected.map(function (r) { return r.reason; }),
      ["badDate", "zeroAmount", "badAmount"]);
    check("bad lines", badBuilt.rejected.map(function (r) { return r.line; }), [2, 3, 4]);

    /* 6 — no amount column at all is a named error, not a silent zero. */
    var noAmount = build({ rows: [["01.02.2026", "x"]], rowLines: [2] },
      { date: 0, note: 1, amount: null, debit: null, credit: null, signRule: "negativeIsExpense" }, {});
    check("noAmountColumn", noAmount.error, "csv.noAmountColumn");
    check("noDateColumn", build({ rows: [["1"]], rowLines: [2] }, { date: null, amount: 0 }, {}).error,
      "csv.noDateColumn");
    check("empty build", build({ rows: [] }, { date: 0, amount: 1 }, {}).error, "csv.empty");

    /* 7 — in-file repeats are reported but both rows import (two real coffees). */
    var twice = table("Tarih;Aciklama;Tutar\n05.02.2026;kahve;-35,00\n05.02.2026;kahve;-35,00\n");
    var twiceRoles = guessRoles(twice.headers, twice.rows, { delimiter: ";" });
    var twiceBuilt = build(twice, twiceRoles, {});
    check("in-file drafts", twiceBuilt.drafts.length, 2);
    check("in-file duplicate flag", twiceBuilt.duplicates.length, 1);
    check("in-file marked", twiceBuilt.duplicates[0].inFile, true);

    /* 8 — quoted multiline note survives all the way into a draft. */
    var multi = table("Tarih;Aciklama;Tutar\n05.02.2026;\"iki\nsatır\";-1,00\n");
    var multiRoles = guessRoles(multi.headers, multi.rows, { delimiter: ";" });
    var multiBuilt = build(multi, multiRoles, {});
    check("multiline note tidied", multiBuilt.drafts[0].note, "iki satır");

    if (global.console) {
      global.console.log("Moon.Importer selftest: " + results.pass + "/" + results.total + " pass");
      results.failures.forEach(function (line) {
        global.console.log("  FAIL " + line);
      });
    }
    return results;
  };
})(window);
