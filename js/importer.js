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
  var TRACK_MIN = 0.7;             /* share of rows a balance must follow      */
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

  /* Matching a Kategori cell against a category name has to fold diacritics:
     bank exports write "Maas" and "Ulasim" where the catalog says "Maaş" and
     "Ulaşım", and util.searchKey keeps the diacritics (it also builds the
     duplicate fingerprint, which must stay strict, so it cannot be loosened).
     Both sides go through the same CSV fold the header dictionary uses.
     searchKey stays the fallback for a name the ASCII fold would empty, e.g.
     a category written in a non-Latin script. */
  function categoryKey(value) {
    var folded = fold(value);
    if (folded) return folded;
    if (Moon.util && typeof Moon.util.searchKey === "function") return Moon.util.searchKey(value);
    return String(value === null || value === undefined ? "" : value).toLowerCase();
  }

  /* A statement whose amount column carries no sign puts the direction in a
     words column ("İşlem Türü": Gelir / Gider). The header dictionary maps
     such a column to `category` — the only role the contract has for a words
     column — so the word arrives in build as a category cell that matches no
     category. Reading it there is what keeps a rent payment from being written
     as income: with signRule "negativeIsExpense" every unsigned row would
     otherwise be "in". The amount's own sign always wins; a cell that does
     name a real category stays a category, and then that category's kind is
     the direction evidence instead. */
  var DIRECTION_WORDS = {
    gider: "out", borc: "out", cikan: "out", cikis: "out", harcama: "out",
    odeme: "out", odenen: "out", cekilen: "out", debit: "out", dr: "out",
    withdrawal: "out", withdrawals: "out", payment: "out", expense: "out",
    out: "out", outflow: "out", paidout: "out", moneyout: "out",
    gelir: "in", alacak: "in", giren: "in", giris: "in", yatan: "in",
    tahsil: "in", tahsilat: "in", credit: "in", cr: "in", deposit: "in",
    income: "in", "in": "in", inflow: "in", paidin: "in", moneyin: "in"
  };

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

  /* Does this cell LOOK like money, as opposed to merely surviving the amount
     parser? Money.parse is deliberately forgiving: it throws away everything
     that is not a digit, a separator or a sign, so "AYDEDE MARKET SUBE 12"
     comes back as 12,00 and a card number as a fortune. Forgiveness is right
     once the reader has pointed at the amount column, and wrong while the
     question is still which column holds the money — every description column
     with a branch number in it would be a candidate. So the scorer asks for the
     shape of a number, optionally signed, bracketed or carrying a unit, and
     nothing else. */
  function moneyShape(text) {
    var s = String(text === null || text === undefined ? "" : text)
      .replace(/[\s  ]+/g, "");
    if (!s) return false;
    s = s.replace(/^\(/, "").replace(/\)$/, "");
    s = s.replace(/^[+\-−]/, "").replace(/[+\-−]$/, "");
    s = s.replace(/^(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£)/i, "");
    s = s.replace(/(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£)$/i, "");
    return /^\d+(?:[.,]\d+)*$/.test(s);
  }

  /* A cell that is money and is not a date. "02.03.2026" passes moneyShape —
     digits and separators are all it is — and a date column must never be
     counted towards a money column's score. */
  function moneyValue(text) {
    if (!moneyShape(text)) return null;
    if (readDate(text, "auto")) return null;
    var read = readAmount(text, "auto");
    if (!read.ok) return null;
    return read.negative ? -read.minor : read.minor;
  }

  /* The date a merged cell opens with. A page whose columns ran together hands
     over "13/03/2026AYDEDE MARKET" as one cell, and this is what lets that
     column be split instead of the file refused. The parser decides whether the
     matched text is a real date, so "1.234,56" and "12.34.56" are not dates. */
  var LEADING_DATE = /^\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/;

  /* The amount a merged cell ends with. Two fraction digits are required: that
     is what separates a trailing amount from a branch number at the end of a
     merchant name, which must stay part of the description. */
  var TRAILING_AMOUNT = /([+\-−]?\d{1,3}(?:[.,  ]\d{3})*[.,]\d{2})\s*(?:TL|TRY|₺)?\s*$/i;

  function leadingDate(text) {
    var match = LEADING_DATE.exec(String(text === null || text === undefined ? "" : text));
    if (!match) return null;
    return readDate(match[1], "auto") ? match[1] : null;
  }

  function trailingAmount(text) {
    var match = TRAILING_AMOUNT.exec(String(text === null || text === undefined ? "" : text));
    if (!match) return null;
    return moneyValue(match[1]) === null ? null : match[1];
  }

  /* A row with no date anywhere on it is not a transaction: it is a rate table
     line, a total, an address or a legal footer. */
  function hasDateCell(row) {
    if (!Array.isArray(row)) return false;
    for (var i = 0; i < row.length; i += 1) {
      var text = cell(row, i);
      if (!/\S/.test(text)) continue;
      if (readDate(text, "auto")) return true;
      if (leadingDate(text)) return true;
    }
    return false;
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
      if (moneyValue(value) !== null) hits += 1;
    });
    return hits / pool.length;
  }

  /* How many of a column's filled cells open with a date that is glued to
     something else. A column that is already a clean date column scores 0 here,
     because it needs no splitting. */
  function gluedDateRatio(values) {
    var pool = filled(values);
    if (!pool.length) return 0;
    var hits = 0;
    pool.forEach(function (value) {
      if (readDate(value, "auto")) return;
      if (leadingDate(value)) hits += 1;
    });
    return hits / pool.length;
  }

  function signedColumn(values) {
    return values.map(function (value) {
      return /\S/.test(value) ? moneyValue(value) : null;
    });
  }

  function mixedSigns(values) {
    var positive = false;
    var negative = false;
    signedColumn(values).forEach(function (minor) {
      if (minor === null || minor === 0) return;
      if (minor < 0) negative = true; else positive = true;
    });
    return positive && negative;
  }

  /* The one column in a statement whose values can be predicted: a running
     balance is the figure above it plus this row's amount. That arithmetic is a
     far stronger signal than "it keeps going the same way" — a month of
     spending interrupted by one salary payment leaves a balance column only
     four fifths monotone, well under MONO_MIN, and a monotone-only test would
     leave it in the running to be imported as the amount. */
  function tracksAsBalance(balance, amount) {
    var pairs = 0;
    var hits = 0;
    for (var i = 1; i < balance.length; i += 1) {
      if (balance[i] === null || balance[i - 1] === null || amount[i] === null) continue;
      pairs += 1;
      if (balance[i] - balance[i - 1] === amount[i]) hits += 1;
    }
    /* One agreeing pair is a coincidence, not a pattern. */
    return pairs >= 2 ? hits / pairs : 0;
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
    var separators = {};
    for (var i = 0; i < samples.length; i += 1) {
      var match = /^\s*(\d{1,4})([.\/\-])(\d{1,2})[.\/\-](\d{1,4})/.exec(samples[i]);
      if (!match) continue;
      if (Number(match[1]) > 31) return "dmy";          /* ISO: order is moot */
      if (Number(match[1]) > 12) return "dmy";
      if (Number(match[3]) > 12) return "mdy";
      separators[match[2]] = true;
    }
    /* Undecidable from the numbers. The decision then comes from the date
       column itself, not from the file's field delimiter: a dot-separated date
       ("01.09.2026") is European notation and never a US export, so reading it
       as MDY turns 1 September into 9 January. Only a slash-written column
       leaves MDY on the table, and there only for a comma-separated file —
       the wizard still shows csv.err.ambiguousDate and the order selector,
       because Moon.Dates.guessOrder found no evidence either way. */
    if (separators["/"] && !separators["."] && !separators["-"]) {
      return opts && opts.delimiter === "," ? "mdy" : "dmy";
    }
    return "dmy";
  }

  /* ------------------------------------------------------------- roles --- */

  /* Which of several money columns is the amount, and which is the balance.
     The rules, in the order they are allowed to decide:
       1. the arithmetic above, when it fires, which is certain;
       2. a monotone column beside a jumpy one is the balance;
       3. between columns that are still tied, a header that says "Tutar" on
          one of them and nothing on the other is believed — the arithmetic has
          already had its say, so a mis-named balance cannot get in this way,
          and an instalment count beside a correctly named amount column would
          otherwise win on rule 5 for having smaller numbers in it;
       4. then mixed signs win, because a statement's amount column carries both
          directions and a balance rarely changes sign at all;
       5. then the smaller figures win, because a balance is the running total
          of the amounts beside it and therefore larger. */
  function chooseAmount(pool, columns, claimed) {
    if (!pool.length) return { amount: null, balance: null };
    if (pool.length === 1) return { amount: pool[0], balance: null };

    var signed = {};
    var shapes = {};
    var mixed = {};
    pool.forEach(function (index) {
      signed[index] = signedColumn(columns[index]);
      shapes[index] = balanceShape(columns[index]);
      mixed[index] = mixedSigns(columns[index]);
    });

    var i;
    var j;
    for (i = 0; i < pool.length; i += 1) {
      for (j = 0; j < pool.length; j += 1) {
        if (i === j) continue;
        if (tracksAsBalance(signed[pool[j]], signed[pool[i]]) >= TRACK_MIN) {
          return { amount: pool[i], balance: pool[j] };
        }
      }
    }

    var flat = pool.filter(function (index) { return shapes[index].monotone < MONO_MIN; });
    var balance = null;
    if (flat.length && flat.length < pool.length) {
      /* Two signals agreeing: the column climbs in one direction, and of the
         ones that do it is the rightmost, which is where a statement prints
         the balance. */
      var monotone = pool.filter(function (index) { return flat.indexOf(index) === -1; });
      balance = monotone[monotone.length - 1];
    }

    var candidates = (flat.length ? flat : pool).slice().sort(function (a, b) {
      var byHeader = (claimed[b] === "amount" ? 1 : 0) - (claimed[a] === "amount" ? 1 : 0);
      if (byHeader !== 0) return byHeader;
      var bySign = (mixed[b] ? 1 : 0) - (mixed[a] ? 1 : 0);
      if (bySign !== 0) return bySign;
      var byMedian = shapes[a].median - shapes[b].median;
      if (byMedian !== 0) return byMedian;
      return a - b;
    });
    return { amount: candidates[0], balance: balance };
  }

  /* Puts the date a merged cell opens with into a column of its own. The
     original header follows the remainder, since that is what it described;
     the date half is left unnamed, which costs nothing now that the date is
     found by reading the cells. A row of this column that carries no leading
     date keeps its text whole rather than losing it. */
  function splitLeadingDate(table, index) {
    var headers = table.headers.slice();
    headers.splice(index, 0, "");
    var rows = table.rows.map(function (row) {
      var copy = Array.isArray(row) ? row.slice() : [];
      while (copy.length <= index) copy.push("");
      var text = String(copy[index] === null || copy[index] === undefined ? "" : copy[index]);
      var head = leadingDate(text);
      if (head) copy.splice(index, 1, head, tidy(text.slice(text.indexOf(head) + head.length)));
      else copy.splice(index, 1, "", tidy(text));
      return copy;
    });
    return { headers: headers, rows: rows, rowLines: table.rowLines };
  }

  /* The same operation at the other end of the cell, for a page that merged all
     of a row into one run of text. It is reached only when the table holds no
     money column at all, so there is nothing it can take away from. */
  function splitTrailingAmount(table, index) {
    var headers = table.headers.slice();
    headers.splice(index + 1, 0, "");
    var rows = table.rows.map(function (row) {
      var copy = Array.isArray(row) ? row.slice() : [];
      while (copy.length <= index) copy.push("");
      var text = String(copy[index] === null || copy[index] === undefined ? "" : copy[index]);
      var tail = trailingAmount(text);
      if (tail) copy.splice(index, 1, tidy(text.slice(0, text.lastIndexOf(tail))), tail);
      else copy.splice(index, 1, tidy(text), "");
      return copy;
    });
    return { headers: headers, rows: rows, rowLines: table.rowLines };
  }

  function widthOf(headers, rows) {
    var width = headers.length;
    rows.forEach(function (row) {
      if (Array.isArray(row) && row.length > width) width = row.length;
    });
    return width;
  }

  /* The column most worth splitting: the one where a date is glued to something
     else most often. Returns null when no column is worth it. */
  function gluedColumn(headers, rows) {
    var width = widthOf(headers, rows);
    var best = null;
    var bestRatio = 0;
    for (var i = 0; i < width; i += 1) {
      var ratio = gluedDateRatio(columnValues(rows, i));
      if (ratio >= SCORE_MIN && ratio > bestRatio) {
        best = i;
        bestRatio = ratio;
      }
    }
    return best;
  }

  function trailingColumn(headers, rows) {
    var width = widthOf(headers, rows);
    var best = null;
    var bestRatio = 0;
    for (var i = 0; i < width; i += 1) {
      var values = filled(columnValues(rows, i));
      if (!values.length) continue;
      var hits = 0;
      values.forEach(function (value) {
        if (trailingAmount(value)) hits += 1;
      });
      var ratio = hits / values.length;
      if (ratio >= SCORE_MIN && ratio > bestRatio) {
        best = i;
        bestRatio = ratio;
      }
    }
    return best;
  }

  /* The whole inference, over one table. guessRoles below decides WHICH table:
     it drops the lines that are not transactions first, and splits a merged
     column when that is the only way a date can be found, calling this again on
     the table it produced. */
  function infer(headers, rows, opts) {
    var width = widthOf(headers, rows);

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

    /* date — the cells decide. A bank that writes "İşlem Tarihi" over its date
       column is being helpful, but a statement read off a page has no header at
       all, and the old order — header first, cells only as a tie-breaker — is
       what made this function answer null on one and stop the wizard to ask a
       question nobody should have to answer. So the column with the most values
       that parse as a date wins outright, and the header is consulted only
       where the cells have nothing to say. */
    var dateClaims = claims("date");
    var dateGuess = bestBy(range(width), dateScores);
    if (dateGuess !== null && dateScores[dateGuess] >= SCORE_MIN) {
      out.date = dateGuess;
      out.guessedFromContent.push("date");
    } else if (dateClaims.length && dateScores[bestBy(dateClaims, dateScores)] > 0) {
      out.date = bestBy(dateClaims, dateScores);
    } else if (dateGuess !== null && dateScores[dateGuess] > 0) {
      /* Below the majority a column needs to be called a date column, but
         there are dates in it, and a date somewhere beats no date at all: the
         rows that do not parse become named rejections in the review, which the
         reader can see and act on. A question they cannot answer is worse. */
      out.date = dateGuess;
      out.guessedFromContent.push("date");
    } else if (dateClaims.length) {
      out.date = dateClaims[0];
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

    /* amount — the cells decide here too, with one exception that no content
       test can settle: a named debit/credit pair. Two columns of unsigned
       figures look identical from the inside, and only their headers say which
       way the money went, so when they are named nothing else is an amount. */
    var amountClaims = claims("amount");
    if (out.debit !== null && out.credit !== null) {
      out.amount = null;
    } else {
      /* A column the header calls a balance is out of the running before the
         cells are consulted: using one as the amount is the classic import bug
         this file opens by warning about, and no content test is worth
         overruling the one thing the bank said plainly. */
      var pool = range(width).filter(function (index) {
        return index !== out.date && index !== out.debit && index !== out.credit
          && index !== out.balance
          && claimed[index] !== "note" && claimed[index] !== "category"
          && moneyScores[index] >= SCORE_MIN;
      });
      var picked = chooseAmount(pool, columns, claimed);
      if (picked.amount !== null) {
        out.amount = picked.amount;
        out.guessedFromContent.push("amount");
        /* A balance the header already named stays named; one the arithmetic
           found is added, because leaving it unclaimed lets the note rule take
           it and the review then shows a balance where a description belongs. */
        if (picked.balance !== null && out.balance === null) out.balance = picked.balance;
      } else if (amountClaims.length) {
        /* No column carries a majority of money — a statement of one or two
           lines, or a column of blanks and dashes. The header is all there is. */
        out.amount = bestBy(amountClaims, moneyScores);
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
    } else if (looksLikeCard(headers, out, opts)) {
      out.signRule = "positiveIsExpense";
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

  /**
   * Works out what the columns of a parsed table mean.
   *
   * Beyond the roles themselves the answer carries the table the roles are
   * indices INTO, which is not always the table that came in: lines that are
   * not transactions are dropped before anything is scored, and a column whose
   * date is glued to its description is split in two. A caller that shows a
   * preview or builds drafts must use `table`, or a split will put the amount
   * role one column to the left of the amounts.
   *
   * @param {string[]} headers
   * @param {string[][]} rows
   * @param {{delimiter?: string, rowLines?: number[]}} [opts]
   * @returns {{date: ?number, note: ?number, amount: ?number, debit: ?number,
   *            credit: ?number, category: ?number, balance: ?number,
   *            dateOrder: string, decimal: string, signRule: string,
   *            scores: {date: number, amount: number},
   *            guessedFromContent: string[],
   *            table: {headers: string[], rows: string[][], rowLines: ?number[]},
   *            dropped: number, split: ?{index: number, kind: string},
   *            confident: boolean}}
   */
  /* Words that only a card statement uses. An instalment is the clearest of
     them: a current account has no concept of one. "Ekstre" and "hesap özeti"
     are the documents themselves, and the minimum payment and the period's debt
     are figures only a card prints. */
  var CARD_WORDS = [
    "taksit", "asgari", "ekstre", "kredi kart", "donem borcu", "dönem borcu",
    "hesap ozeti", "hesap özeti",
    /* The loyalty schemes. Every Turkish card prints its own points column, and
       the name of that column is often the plainest statement on the page that
       this is a card at all. */
    "parafpara", "bonus", "maximum puan", "worldpuan", "axess", "chip-para",
    "cardfinans", "paraf", "advantage", "bankkart lira", "miles&smiles",
    "credit card", "minimum payment", "statement balance", "instalment",
    "installment", "rewards"
  ];

  /* Is this a card statement rather than an account statement?

     Two things have to agree, because getting it wrong inverts every row. The
     document has to name itself as a card — through the hint the PDF reader
     passes down, or through its own column headings — AND it must have no
     running balance, because a running balance is what an account statement
     carries and a card statement does not. A column called "kalan borç" is an
     instalment remainder, not a balance, which is why the balance role is the
     discriminator rather than the word. */
  function looksLikeCard(headers, out, opts) {
    /* The page's own words come first and settle it on their own. They are read
       from the whole document — the masthead, the summary box, the payment
       dates — which is far more evidence than a column heading carries, and a
       statement that names itself a card is a card whatever its columns look
       like. A card's fourth column is usually the instalment left to run, and
       that is close enough to a balance that the role guesser claims it; making
       the balance role a veto here would hand every such statement back to the
       account reading and invert every row on it. */
    if (opts && opts.documentKind === "card") return true;
    if (opts && opts.documentKind === "account") return false;

    /* Nothing in the page said. Now the columns have to carry it, and a running
       balance is the one thing a card statement does not have. */
    if (out.balance !== null && out.balance !== undefined) return false;

    var haystack = (headers || []).map(function (one) {
      return fold(one);
    }).join(" ");
    if (!haystack) return false;

    for (var i = 0; i < CARD_WORDS.length; i += 1) {
      if (haystack.indexOf(fold(CARD_WORDS[i])) !== -1) return true;
    }
    return false;
  }

  function guessRoles(headers, rows, opts) {
    opts = opts || {};
    headers = Array.isArray(headers) ? headers : [];
    rows = Array.isArray(rows) ? rows : [];
    var lines = Array.isArray(opts.rowLines) ? opts.rowLines : null;

    /* A line with no date anywhere on it is not a transaction, and it is in the
       way: a rate table's percentages and a DÖNEM BORCU total are money in the
       same columns as the amounts, and scoring them alongside the real rows is
       how a reader ends up being asked which column holds the date. They go
       before anything is measured, and the count goes back with the answer so
       the review can say how many lines were left out. */
    var kept = [];
    var keptLines = [];
    var dropped = 0;
    rows.forEach(function (row, at) {
      if (hasDateCell(row)) {
        kept.push(row);
        if (lines) keptLines.push(lines[at]);
      } else {
        dropped += 1;
      }
    });

    var table = { headers: headers, rows: rows, rowLines: lines };
    if (kept.length && dropped) {
      table = { headers: headers, rows: kept, rowLines: lines ? keptLines : null };
    } else {
      /* Either nothing was dropped, or EVERY line would be: a table with no
         date in it at all is handed on whole, so the preview shows the reader
         what Moon saw instead of an empty screen. */
      dropped = 0;
    }

    var split = null;
    var out = infer(table.headers, table.rows, opts);

    if (out.date === null) {
      var glued = gluedColumn(table.headers, table.rows);
      if (glued !== null) {
        table = splitLeadingDate(table, glued);
        split = { index: glued, kind: "date" };
        out = infer(table.headers, table.rows, opts);

        /* A page that merged the date into the description usually merged the
           amount in as well, and a date with no amount beside it builds
           nothing. The second cut is taken only when the table holds no money
           column at all, so it can never take digits off a row that already
           had its amount somewhere else. */
        if (out.amount === null && out.debit === null && out.credit === null) {
          var tail = trailingColumn(table.headers, table.rows);
          if (tail !== null) {
            table = splitTrailingAmount(table, tail);
            split = { index: glued, kind: "dateAmount" };
            out = infer(table.headers, table.rows, opts);
          }
        }
      }
    }

    out.table = table;
    out.dropped = dropped;
    out.split = split;
    out.confident = out.date !== null
      && (out.amount !== null || out.debit !== null || out.credit !== null);
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
      var key = categoryKey(category.name || "");
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

      /* Resolved before the amount, because an unsigned amount asks this
         column which way the money went. */
      var categoryLabel = mapping.category === null || mapping.category === undefined
        ? "" : categoryKey(cell(row, mapping.category));
      var namedCategory = categoryLabel && categories.byName[categoryLabel]
        ? categories.byName[categoryLabel] : null;
      var columnDirection = null;
      if (namedCategory) {
        /* The named category's own kind is direction evidence too: a row filed
           under Market is money going out even when the cell carries no sign. */
        columnDirection = categories.kind[namedCategory] === "income" ? "in" : "out";
      } else if (categoryLabel && DIRECTION_WORDS[categoryLabel]) {
        columnDirection = DIRECTION_WORDS[categoryLabel];
      }

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
        /* A credit card statement reads the other way round. Its amount column
           lists what the card spent, so an unsigned figure is money going out,
           and the few negative rows are the payments that reduced the debt.
           Reading such a statement under the ordinary rule turns a month of
           shopping into a month of income, which is the one import mistake
           that silently ruins every number the app reports. */
        var positiveIsOut = mapping.signRule === "positiveIsExpense";
        if (positiveIsOut) direction = read.negative ? "in" : (columnDirection || "out");
        else direction = read.negative ? "out" : (columnDirection || "in");
        minor = read.minor;
      }

      if (minor === 0) {
        out.rejected.push({ line: line, reason: "zeroAmount", value: tidy(amountText).slice(0, 40) });
        continue;
      }

      var note = tidy(cell(row, mapping.note)).slice(0, NOTE_MAX);

      var categoryId = namedCategory;
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

    /* 9 — a dot-written date column is day-first whatever the field delimiter
       is: "01.09.2026" in a comma file used to arrive as 9 January. */
    var dotted = table("Date,Description,Amount\n01.09.2026,A,-5.00\n02.09.2026,B,-6.00\n"
      + "03.09.2026,C,-7.00\n04.09.2026,D,-8.00\n");
    var dottedRoles = guessRoles(dotted.headers, dotted.rows, { delimiter: "," });
    check("dotted dateOrder", dottedRoles.dateOrder, "dmy");
    var dottedBuilt = build(dotted, dottedRoles, { monthStartDay: 1 });
    check("dotted dates", dottedBuilt.drafts.map(function (d) { return d.date; }),
      ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    check("dotted one period", dottedBuilt.summary.periods, ["2026-09"]);
    var slashed = table("Date,Description,Amount\n01/09/2026,A,-5.00\n02/09/2026,B,-6.00\n");
    check("slashed comma stays mdy",
      guessRoles(slashed.headers, slashed.rows, { delimiter: "," }).dateOrder, "mdy");
    var dottedSemi = table("Tarih;Aciklama;Tutar\n01.09.2026;A;-5,00\n02.09.2026;B;-6,00\n");
    check("dotted semicolon dmy",
      guessRoles(dottedSemi.headers, dottedSemi.rows, { delimiter: ";" }).dateOrder, "dmy");

    /* A fixed catalog for the two category tests: the real one depends on
       Store.boot() and on the active language. */
    var realModel = Moon.Model;
    Moon.Model = {
      categories: function () {
        return [
          { id: "c_market", name: "Market", kind: "expense", fixed: false },
          { id: "c_kira", name: "Kira", kind: "expense", fixed: true },
          { id: "c_ulasim", name: "Ulaşım", kind: "expense", fixed: false },
          { id: "c_saglik", name: "Sağlık", kind: "expense", fixed: false },
          { id: "c_diger", name: "Diğer", kind: "expense", fixed: false },
          { id: "c_maas", name: "Maaş", kind: "income", fixed: false }
        ];
      },
      entries: function () { return []; }
    };
    try {
      /* 10 — a Kategori cell written without Turkish letters still finds its
         category instead of sliding into the bulk default. */
      var cats = table("Tarih;Aciklama;Kategori;Tutar\n"
        + "01.09.2026;MIGROS;Market;-100,00\n"
        + "02.09.2026;KIRA;Kira;-5.000,00\n"
        + "03.09.2026;MAAS;Maas;20.000,00\n"
        + "04.09.2026;OTOBUS;Ulasim;-30,00\n"
        + "05.09.2026;ECZANE;Saglik;-10,00\n");
      var catRoles = guessRoles(cats.headers, cats.rows, { delimiter: ";" });
      check("category column found", catRoles.category, 2);
      var catBuilt = build(cats, catRoles, { defaultCategoryId: "c_diger" });
      check("folded category match", catBuilt.drafts.map(function (d) { return d.categoryId; }),
        ["c_market", "c_kira", "c_maas", "c_ulasim", "c_saglik"]);
      check("folded category fixed flag", catBuilt.drafts[1].fixed, true);

      /* 11 — unsigned amounts with a direction word column: the word decides,
         so rent is not written as income. A signed amount still wins. */
      var typed = table("Tarih;Aciklama;Islem Turu;Tutar\n"
        + "01.09.2026;MAAS ODEMESI;Gelir;38.500,00\n"
        + "02.09.2026;KIRA ODEMESI;Gider;14.000,00\n"
        + "03.09.2026;MIGROS;Gider;1.847,60\n");
      var typedRoles = guessRoles(typed.headers, typed.rows, { delimiter: ";" });
      var typedBuilt = build(typed, typedRoles, {});
      check("direction word rows", typedBuilt.drafts.map(function (d) { return d.direction; }),
        ["in", "out", "out"]);
      check("direction word sums", [typedBuilt.summary.sumIn, typedBuilt.summary.sumOut],
        [3850000, 1584760]);
      check("direction word is not a category",
        typedBuilt.drafts.map(function (d) { return d.categoryId; }), [null, null, null]);
      var signedWord = table("Tarih;Aciklama;Islem Turu;Tutar\n"
        + "01.09.2026;IADE;Gider;-100,00\n02.09.2026;FAIZ;Gelir;50,00\n");
      var signedBuilt = build(signedWord,
        guessRoles(signedWord.headers, signedWord.rows, { delimiter: ";" }), {});
      check("sign beats the word",
        signedBuilt.drafts.map(function (d) { return d.direction; }), ["out", "in"]);
      /* An unsigned row filed under an expense category is money going out,
         and it keeps its category instead of being dropped as a mismatch. */
      var unsignedCat = table("Tarih;Aciklama;Kategori;Tutar\n"
        + "01.09.2026;X;Market;100,00\n02.09.2026;Y;Maas;200,00\n");
      var unsignedBuilt = build(unsignedCat,
        guessRoles(unsignedCat.headers, unsignedCat.rows, { delimiter: ";" }), {});
      check("category kind decides direction",
        unsignedBuilt.drafts.map(function (d) { return [d.direction, d.categoryId]; }),
        [["out", "c_market"], ["in", "c_maas"]]);
    } finally {
      Moon.Model = realModel;
    }

    /* ----------------------------------------------- inference, section D --- */

    /* 12 — a statement read off a page has no header at all. The columns must
       come out of the cells, and nothing may be asked. */
    var bare = table("A;B;C;D\n"
      + "14/02/2026;AYDEDE MARKET SUBE 12;412.90;0.00\n"
      + "15/02/2026;GUNESLI KAHVE EVI;86.50;0.00\n"
      + "16/02/2026;BULUT AKARYAKIT;1250.00;0.00\n"
      + "17/02/2026;FENER BILGISAYAR 1/12;624.75;6872.25\n"
      + "19/02/2026;ZEYTIN ECZANESI;234.60;0.00\n"
      + "20/02/2026;KOPRU INTERNET;549.00;0.00\n"
      + "21/02/2026;MASAL KITABEVI;318.40;0.00\n"
      + "23/02/2026;YOLCU KART DOLUM;150.00;0.00\n"
      + "06/03/2026;HESABA ODEME;-3500.00;0.00\n");
    var bareRoles = guessRoles(bare.headers, bare.rows, { delimiter: ";" });
    check("headerless roles",
      [bareRoles.date, bareRoles.note, bareRoles.amount], [0, 1, 2]);
    check("headerless instalment column is not the amount", bareRoles.balance, 3);
    check("headerless is confident", bareRoles.confident, true);
    check("headerless decimal", bareRoles.decimal, ".");

    /* 13 — a description column with a branch number in it is not money. This
       is what Money.parse on its own would say otherwise, since it reads
       "AYDEDE MARKET SUBE 12" as twelve lira. */
    check("a numbered merchant name is not an amount",
      moneyRatio(["AYDEDE MARKET SUBE 12", "FENER BILGISAYAR 1/12", "KOPRU INTERNET"]), 0);
    check("a date cell is not an amount", moneyRatio(["02.03.2026", "13/03/2026"]), 0);
    check("a signed amount with a unit is", moneyRatio(["-1.234,56 TL", "(89,00)", "₺12"]), 1);

    /* 14 — the lines that are not transactions go before anything is scored,
       and their count comes back so the review can say how many there were.
       The two totals lines below carry money in the amount column, which is
       exactly what used to drag the scoring off the real rows. */
    var totals = table("A;B;C\n"
      + "FAIZ ORANI;% 3.11;% 37.32\n"
      + "14/02/2026;AYDEDE MARKET;412.90\n"
      + "15/02/2026;GUNESLI KAHVE;86.50\n"
      + "16/02/2026;BULUT AKARYAKIT;1250.00\n"
      + "DONEM ICI ISLEM TOPLAMI;1749.40;\n"
      + "DONEM BORCU;1749.40;\n");
    var totalsRoles = guessRoles(totals.headers, totals.rows, { delimiter: ";" });
    check("undated lines are dropped", totalsRoles.dropped, 3);
    check("only the transactions are left", totalsRoles.table.rows.length, 3);
    check("totals do not move the roles",
      [totalsRoles.date, totalsRoles.note, totalsRoles.amount], [0, 1, 2]);
    check("date score is read from the transactions only", totalsRoles.scores.date, 1);

    /* 15 — a date glued to the description. The column is split in two and the
       rest of the inference runs on the table that comes out, so the role
       numbers below are indices into `table`, not into what went in. */
    var glued = table("A;B\n"
      + "02.03.2026AYDEDE MARKET;-624,30\n"
      + "03.03.2026CINAR ELEKTRIK;-418,70\n"
      + "05.03.2026KIRA TRANSFERI;-9.000,00\n"
      + "06.03.2026MAAS ODEMESI;41.250,00\n");
    var gluedRoles = guessRoles(glued.headers, glued.rows, { delimiter: ";" });
    check("glued date is split out", gluedRoles.split, { index: 0, kind: "date" });
    check("glued roles", [gluedRoles.date, gluedRoles.note, gluedRoles.amount], [0, 1, 2]);
    check("glued first row", gluedRoles.table.rows[0],
      ["02.03.2026", "AYDEDE MARKET", "-624,30"]);
    var gluedBuilt = build({ rows: gluedRoles.table.rows, rowLines: gluedRoles.table.rowLines },
      gluedRoles, {});
    check("glued rows build", gluedBuilt.drafts.length, 4);
    check("glued dates", gluedBuilt.drafts.map(function (d) { return d.date; }),
      ["2026-03-02", "2026-03-03", "2026-03-05", "2026-03-06"]);
    check("glued directions", gluedBuilt.drafts.map(function (d) { return d.direction; }),
      ["out", "out", "out", "in"]);

    /* 16 — the whole row in one cell, which is what a page whose columns ran
       together hands over. The amount comes off the end as well, and only
       because there was no money column anywhere else to use. */
    var merged = table("A\n"
      + "02.03.2026AYDEDE MARKET 624.30\n"
      + "03.03.2026CINAR ELEKTRIK 418.70\n"
      + "05.03.2026KIRA TRANSFERI 9000.00\n");
    var mergedRoles = guessRoles(merged.headers, merged.rows, { delimiter: ";" });
    check("merged row is cut twice", mergedRoles.split, { index: 0, kind: "dateAmount" });
    check("merged roles",
      [mergedRoles.date, mergedRoles.note, mergedRoles.amount], [0, 1, 2]);
    check("merged first row", mergedRoles.table.rows[0],
      ["02.03.2026", "AYDEDE MARKET", "624.30"]);

    /* 17 — a branch number at the end of a merchant name is not an amount and
       must stay in the description. Two fraction digits are what tell them
       apart, so the cut does not happen here. */
    check("a trailing branch number is left alone",
      trailingAmount("AYDEDE MARKET SUBE 12"), null);
    check("a trailing amount is taken",
      trailingAmount("AYDEDE MARKET 1.234,56"), "1.234,56");

    /* 18 — an amount column beside a running balance, with the balance broken
       out of its monotone run by one salary payment. The arithmetic finds it
       where "it keeps going the same way" cannot: this balance column is only
       four fifths monotone, under MONO_MIN. */
    var running = table("A;B;C;D\n"
      + "02.03.2026;AYDEDE MARKET;-624,30;11.855,85\n"
      + "03.03.2026;CINAR ELEKTRIK;-418,70;11.437,15\n"
      + "05.03.2026;KIRA TRANSFERI;-9.000,00;2.437,15\n"
      + "06.03.2026;MAAS ODEMESI;41.250,00;43.687,15\n"
      + "09.03.2026;BULUT OTOGAZ;-1.180,00;42.507,15\n"
      + "11.03.2026;KOPRU INTERNET;-549,00;41.958,15\n"
      + "13.03.2026;GUNES KAHVE EVI;-97,50;41.860,65\n");
    var runningRoles = guessRoles(running.headers, running.rows, { delimiter: ";" });
    check("running balance found by its arithmetic",
      [runningRoles.amount, runningRoles.balance], [2, 3]);
    check("the balance is not the amount", runningRoles.amount !== runningRoles.balance, true);
    var runningBuilt = build({ rows: runningRoles.table.rows }, runningRoles, {});
    check("running sums", [runningBuilt.summary.sumIn, runningBuilt.summary.sumOut],
      [4125000, 1186950]);

    /* 19 — a majority is no longer required of the date column. Three rows in
       five parse; the other two become named rejections the reader can see,
       which beats a question they cannot answer. */
    var patchy = table("Tarih;Aciklama;Tutar\n"
      + "01.09.2026;A;-5,00\n"
      + "02.09.2026;B;-6,00\n"
      + "03.09.2026;C;-7,00\n"
      + "32.13.2026;D;-8,00\n"
      + "sonraki sayfa;E;-9,00\n");
    var patchyRoles = guessRoles(patchy.headers, patchy.rows, { delimiter: ";" });
    check("date role survives bad rows", patchyRoles.date, 0);
    check("never null while a date exists", patchyRoles.date !== null, true);

    /* 20 — nothing resembling a date anywhere. The answer is honestly null,
       and the table is handed back whole so the preview still shows it. */
    var undated = table("A;B\nkahve;-35,00\nmarket;-12,00\n");
    var undatedRoles = guessRoles(undated.headers, undated.rows, { delimiter: ";" });
    check("no date is still no date", undatedRoles.date, null);
    check("not confident without a date", undatedRoles.confident, false);
    check("nothing dropped when every row would be", undatedRoles.dropped, 0);
    check("the table is handed back whole", undatedRoles.table.rows.length, 2);

    /* 21a — an instalment column beside the amount column. Its figures are the
       smaller ones, so the magnitude rule alone would import the instalment
       count as the spending; the header breaks the tie first. */
    var instalment = table("Tarih;Aciklama;Tutar;Taksit\n"
      + "01.09.2026;A;-1.250,00;3,00\n"
      + "02.09.2026;B;-840,00;1,00\n"
      + "03.09.2026;C;-2.100,00;12,00\n"
      + "04.09.2026;D;-375,00;6,00\n");
    var instalmentRoles = guessRoles(instalment.headers, instalment.rows, { delimiter: ";" });
    check("the named amount beats the smaller column", instalmentRoles.amount, 2);

    /* 21 — a named debit/credit pair is the one thing the cells cannot settle,
       so the headers still win there and no amount role is invented. */
    var pair = table("Date;Description;Debit;Credit\n"
      + "2026-09-01;Salary;;3200.00\n2026-09-02;Rent;1150.00;\n");
    var pairRoles = guessRoles(pair.headers, pair.rows, { delimiter: ";" });
    check("debit/credit keeps its pair",
      [pairRoles.amount, pairRoles.debit, pairRoles.credit], [null, 2, 3]);
    check("debit/credit sign rule", pairRoles.signRule, "debitCredit");

    /* 22 — the row numbers travel with the rows that survive, so a rejection
       in the review still points at the line it came from. */
    var lined = guessRoles(["A", "B"],
      [["TOPLAM", "100,00"], ["02.03.2026", "-5,00"], ["02.03.2026", "-6,00"]],
      { delimiter: ";", rowLines: [11, 12, 13] });
    check("row lines follow the rows", lined.table.rowLines, [12, 13]);

    if (global.console) {
      global.console.log("Moon.Importer selftest: " + results.pass + "/" + results.total + " pass");
      results.failures.forEach(function (line) {
        global.console.log("  FAIL " + line);
      });
    }
    return results;
  };
})(window);
