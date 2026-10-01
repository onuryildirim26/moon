/* Moon — CSV engine (bytes in, table out).
 *
 * This is the file that meets real-world mess: bank exports with a page of
 * free text before the header, Excel's "sep=;" preamble, windows-1254 bytes,
 * quoted delimiters, quoted newlines, a repeated header where the PDF broke
 * the page, a trailing TOPLAM row, ragged rows and quotes nobody closed.
 *
 * Contract: 02-sozlesme.md §8. Depends on Moon.util only — no dates, no money,
 * no DOM, no i18n. Keeping it that narrow is what makes it testable under node
 * (see _selftest at the bottom) and what keeps load order from mattering.
 *
 * Nothing here throws for bad *content*: bad content becomes an entry in
 * `issues`. Only three conditions are hard failures, and each carries an i18n
 * key on `error.key`: csv.empty, csv.tooLarge, csv.tooManyRows.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var MAX_BYTES = 5 * 1024 * 1024;   /* 5 MB — beyond this localStorage is a lie */
  var MAX_ROWS = 50000;              /* data rows, header excluded */

  var SNIFF_CHARS = 64 * 1024;       /* prefix the sniffer reasons about */
  var SNIFF_RECORDS = 20;            /* scored records per delimiter candidate */
  var HEADER_SEARCH = 25;            /* how deep the header may hide */
  var HEADER_LOOKAHEAD = 3;          /* rows that must agree with the header */

  /* A quoted field may legitimately span lines, but an unclosed quote must not
     eat the rest of the file. After this many line breaks inside one field the
     parser decides the quote was a typo, reports it, and re-reads that row
     literally so every later row survives. */
  var MAX_QUOTED_LINES = 24;

  var DELIMITERS = [";", ",", "\t", "|"];   /* order matters: ties go to ";" */
  var ENCODINGS = ["utf-8", "windows-1254", "utf-16le", "utf-16be", "latin1"];

  /* Mojibake signature of windows-1254 bytes read as UTF-8 ("Ã¼" for "ü"). */
  var MOJIBAKE = /Ã¼|Ä±|Å\u009F|ÅŸ|Ã§|Ã¶|Ã–|Ä°|Ãœ|Å\u009E/;

  var SUMMARY_WORDS = {
    toplam: 1, geneltoplam: 1, aratoplam: 1, toplamtutar: 1, toplamlar: 1,
    total: 1, totals: 1, grandtotal: 1, subtotal: 1, sum: 1, devir: 1, sonuc: 1
  };

  /* Shape tests only — the real calendar lives in Moon.Dates, and csv.js must
     stay loadable without it. These answer "could this be a date at all". */
  var DATE_SHAPE = /^\s*(\d{1,4}[.\/\-]\d{1,2}[.\/\-]\d{1,4}|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,}\s+\d{2,4})/;
  var FOLD = {
    "ı": "i", "İ": "i", "I": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
    "â": "a", "î": "i", "û": "u", "é": "e"
  };

  function fail(key, params) {
    var error = new Error(key);
    error.key = key;
    error.params = params || null;
    error.moonCsv = true;
    return error;
  }

  function fold(value) {
    if (value === null || value === undefined) return "";
    var text = String(value).replace(/[ıİIşŞğĞüÜöÖçÇâîûé]/g, function (ch) {
      return FOLD[ch] || ch;
    });
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function hasContent(text) {
    return typeof text === "string" && /[^\s﻿]/.test(text);
  }

  function isBlankRecord(record) {
    if (!record || !record.length) return true;
    for (var i = 0; i < record.length; i += 1) {
      if (/[^\s]/.test(record[i])) return false;
    }
    return true;
  }

  function looksLikeDate(value) {
    return DATE_SHAPE.test(String(value === null || value === undefined ? "" : value));
  }

  /* ------------------------------------------------------------- decoding */

  function toBytes(source) {
    if (!source) return null;
    if (typeof Uint8Array === "function" && source instanceof Uint8Array) return source;
    if (typeof ArrayBuffer === "function" && source instanceof ArrayBuffer) return new Uint8Array(source);
    if (source.buffer && typeof source.byteLength === "number") {
      return new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength);
    }
    return null;
  }

  /* Byte-level fallbacks for the (rare) engine without TextDecoder. latin1 is
     lossy for Turkish but never throws, so a preview is still possible. */
  function decodeLatin1(bytes) {
    var out = "";
    var chunk = [];
    for (var i = 0; i < bytes.length; i += 1) {
      chunk.push(bytes[i]);
      if (chunk.length === 8192) {
        out += String.fromCharCode.apply(null, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) out += String.fromCharCode.apply(null, chunk);
    return out;
  }

  function decodeUtf16(bytes, littleEndian) {
    var out = "";
    var chunk = [];
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      chunk.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
      if (chunk.length === 8192) {
        out += String.fromCharCode.apply(null, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) out += String.fromCharCode.apply(null, chunk);
    return out;
  }

  function decodeWith(bytes, label, fatal) {
    if (typeof global.TextDecoder === "function") {
      return new global.TextDecoder(label, { fatal: !!fatal }).decode(bytes);
    }
    if (label === "utf-16le") return decodeUtf16(bytes, true);
    if (label === "utf-16be") return decodeUtf16(bytes, false);
    if (fatal) throw fail("csv.decodeFailed");
    return decodeLatin1(bytes);
  }

  /* Bytes to text, with the encoding written down so the wizard can show it
     and the reader can override it. BOM wins; after that UTF-8 is tried in
     fatal mode, because a silent replacement character is worse than a guess. */
  function decode(source, forced) {
    var bytes = toBytes(source);
    if (!bytes) throw fail("csv.readFailed");
    if (bytes.length === 0) throw fail("csv.empty");
    if (bytes.length > MAX_BYTES) {
      throw fail("csv.tooLarge", { limitMb: Math.round(MAX_BYTES / (1024 * 1024)) });
    }

    var warnings = [];
    var encoding = null;
    var body = bytes;
    var text;

    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      encoding = "utf-8";
      body = bytes.subarray(3);
    } else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      encoding = "utf-16le";
      body = bytes.subarray(2);
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      encoding = "utf-16be";
      body = bytes.subarray(2);
    }

    if (forced && ENCODINGS.indexOf(forced) !== -1) {
      encoding = forced;
      body = bytes;
      if (forced === "utf-8" && bytes.length >= 3 && bytes[0] === 0xEF) body = bytes.subarray(3);
    }

    if (encoding) {
      try {
        text = decodeWith(body, encoding === "latin1" ? "windows-1252" : encoding, false);
      } catch (e) {
        text = decodeLatin1(body);
        encoding = "latin1";
        warnings.push("csv.encodingGuess");
      }
    } else {
      try {
        text = decodeWith(body, "utf-8", true);
        encoding = "utf-8";
      } catch (e) {
        /* Not valid UTF-8: Turkish exports are windows-1254 far more often
           than anything else, so that is the one guess worth making. */
        encoding = "windows-1254";
        warnings.push("csv.encodingGuess");
        try {
          text = decodeWith(body, "windows-1254", false);
        } catch (e2) {
          encoding = "latin1";
          text = decodeLatin1(body);
        }
      }
    }

    /* A leading BOM that survived (utf-16 decoders keep it) would glue itself
       to the first header cell and break column matching silently. */
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    if (text.indexOf("�") !== -1 || MOJIBAKE.test(text)) {
      if (warnings.indexOf("csv.encodingGuess") === -1) warnings.push("csv.encodingGuess");
    }

    return { text: text, encoding: encoding, warnings: warnings, bytes: bytes };
  }

  /* file → text. FileReader only: fetch and XHR are blocked on file://. */
  function read(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(fail("csv.noFile"));
        return;
      }
      if (typeof file.size === "number") {
        if (file.size === 0) {
          reject(fail("csv.empty"));
          return;
        }
        if (file.size > MAX_BYTES) {
          reject(fail("csv.tooLarge", { limitMb: Math.round(MAX_BYTES / (1024 * 1024)) }));
          return;
        }
      }
      if (typeof global.FileReader !== "function") {
        reject(fail("csv.readFailed"));
        return;
      }

      var reader = new global.FileReader();
      reader.onerror = function () { reject(fail("csv.readFailed")); };
      reader.onabort = function () { reject(fail("csv.readFailed")); };
      reader.onload = function () {
        var result;
        try {
          result = decode(reader.result);
        } catch (e) {
          reject(e && e.moonCsv ? e : fail("csv.decodeFailed"));
          return;
        }
        if (!hasContent(result.text)) {
          reject(fail("csv.empty"));
          return;
        }
        resolve(result);
      };

      try {
        reader.readAsArrayBuffer(file);
      } catch (e) {
        reject(fail("csv.readFailed"));
      }
    });
  }

  /* -------------------------------------------------------------- parsing */

  /* One quote-aware state machine, used by the sniffer and by parse so both
     agree on what a "row" is. Returns physical line numbers because that is
     what the reader sees in their file and what every issue must point at. */
  function tokenize(text, delimiter, opts) {
    opts = opts || {};
    var maxRecords = typeof opts.maxRecords === "number" ? opts.maxRecords : Infinity;
    var limit = text.length;
    if (typeof opts.maxChars === "number" && opts.maxChars < limit) limit = opts.maxChars;

    var records = [];
    var lines = [];
    var issues = [];

    var record = [];
    var field = "";
    var i = 0;
    var line = 1;
    var recordLine = 1;

    var inQuotes = false;
    var literal = false;          /* quote handling off until end of line */
    var openIndex = 0;
    var openLine = 1;
    var openRecord = null;
    var quotedLines = 0;

    /* Recovery always restarts *after* the offending quote, so i moves
       forward monotonically; the guard is belt-and-braces, not logic. */
    var guard = limit * 2 + 64;

    function pushRecord() {
      record.push(field);
      field = "";
      records.push(record);
      lines.push(recordLine);
      record = [];
    }

    function recover() {
      issues.push({ line: openLine, kind: "unclosedQuote" });
      record = openRecord ? openRecord.slice() : [];
      field = '"';                /* the stray quote was literal text */
      line = openLine;
      i = openIndex;
      inQuotes = false;
      literal = true;
      quotedLines = 0;
    }

    for (;;) {
      if (guard < 0) break;
      guard -= 1;

      if (i >= limit) {
        if (inQuotes) {
          recover();
          continue;
        }
        break;
      }

      var ch = text.charAt(i);

      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') {   /* "" is an escaped quote */
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
          field += "\n";                      /* newline belongs to the field */
          line += 1;
          quotedLines += 1;
          i += 1;
          if (quotedLines > MAX_QUOTED_LINES) recover();
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }

      if (ch === '"' && !literal && !/[^\s]/.test(field)) {
        inQuotes = true;
        quotedLines = 0;
        openIndex = i + 1;
        openLine = line;
        openRecord = record.slice();
        field = "";                           /* drop padding before the quote */
        i += 1;
        continue;
      }

      if (ch === delimiter) {
        record.push(field);
        field = "";
        i += 1;
        continue;
      }

      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
        i += 1;
        pushRecord();
        line += 1;
        recordLine = line;
        literal = false;
        if (records.length >= maxRecords) {
          return { records: records, lines: lines, issues: issues };
        }
        continue;
      }

      field += ch;
      i += 1;
    }

    if (field !== "" || record.length) pushRecord();

    return { records: records, lines: lines, issues: issues };
  }

  /* Cut a prefix at a line boundary so the sniffer never scores half a row. */
  function headChars(text, count) {
    if (text.length <= count) return text;
    var slice = text.slice(0, count);
    var cut = slice.lastIndexOf("\n");
    return cut > 0 ? slice.slice(0, cut + 1) : slice;
  }

  /* Excel writes "sep=;" on its own first line. It is a statement of fact. */
  function sepDirective(text) {
    var end = text.search(/[\r\n]/);
    var first = (end === -1 ? text : text.slice(0, end)).replace(/^﻿/, "").trim();
    var match = /^"?sep=(.)"?$/i.exec(first);
    if (!match) return null;
    var ch = match[1];
    if (/[A-Za-z0-9"]/.test(ch)) return null;
    return { delimiter: ch };
  }

  function scoreDelimiter(prefix, delimiter) {
    var probe = tokenize(prefix, delimiter, { maxRecords: SNIFF_RECORDS });
    var counts = [];
    var unsplit = 0;
    probe.records.forEach(function (record) {
      if (isBlankRecord(record)) return;
      /* A bank statement opens with several lines of free text — the account
         holder, the branch, the date range — and none of them contain the
         delimiter. Counting those one-field lines lets the preamble outvote the
         real table: seven header lines beat six data rows, the mode comes out 1,
         and the delimiter is thrown away. Only lines the delimiter actually
         split get a vote; the rest are remembered to temper the score. */
      if (record.length > 1) counts.push(record.length);
      else unsplit += 1;
    });
    if (!counts.length) return null;

    var freq = {};
    var modeCount = 0;
    var modeFreq = 0;
    var total = 0;
    counts.forEach(function (n) {
      freq[n] = (freq[n] || 0) + 1;
      total += n;
      if (freq[n] > modeFreq || (freq[n] === modeFreq && n > modeCount)) {
        modeFreq = freq[n];
        modeCount = n;
      }
    });

    /* A delimiter that never splits anything is not a delimiter. */
    if (modeCount <= 1) return null;

    var ratio = modeFreq / counts.length;
    /* How much of the file this delimiter actually explains. A comma that splits
       two lines of a semicolon file should not beat the semicolon on consistency
       alone. */
    var coverage = counts.length / (counts.length + unsplit);
    return {
      delimiter: delimiter,
      score: ratio * coverage * (total / counts.length),
      ratio: ratio,
      coverage: coverage,
      columns: modeCount
    };
  }

  function findHeaderRow(records, startAt) {
    var limit = Math.min(records.length, startAt + HEADER_SEARCH);
    var i;
    var j;

    for (i = startAt; i < limit; i += 1) {
      if (isBlankRecord(records[i])) continue;
      var width = records[i].length;
      if (width <= 2) continue;          /* bank letterhead lines are 1-2 wide */

      var seen = 0;
      var agree = 0;
      for (j = i + 1; j < records.length && seen < HEADER_LOOKAHEAD; j += 1) {
        if (isBlankRecord(records[j])) continue;
        seen += 1;
        if (records[j].length === width) agree += 1;
      }
      if (seen > 0 && agree === seen) return i;
    }

    /* Nothing agreed: take the first row that splits at all. */
    for (i = startAt; i < records.length; i += 1) {
      if (!isBlankRecord(records[i]) && records[i].length > 1) return i;
    }
    return startAt < records.length ? startAt : 0;
  }

  function sniff(text) {
    var out = {
      delimiter: ";",
      headerRow: 0,
      columnCount: 0,
      confidence: 0,
      skippedLines: 0,
      empty: true
    };
    if (!hasContent(text)) return out;
    out.empty = false;

    var prefix = headChars(String(text), SNIFF_CHARS);
    var forced = sepDirective(prefix);
    var startAt = 0;

    if (forced) {
      out.delimiter = forced.delimiter;
      out.confidence = 100;
      startAt = 1;                       /* the directive line is not data */
    } else {
      var best = null;
      DELIMITERS.forEach(function (candidate) {
        var scored = scoreDelimiter(prefix, candidate);
        if (!scored) return;
        if (!best || scored.score > best.score + 1e-9) best = scored;
      });
      if (best) {
        out.delimiter = best.delimiter;
        out.confidence = Math.round(Moon.util.clamp(best.ratio, 0, 1) * 100);
      } else {
        out.confidence = 0;              /* single-column file: still readable */
      }
    }

    var probe = tokenize(prefix, out.delimiter, { maxRecords: startAt + HEADER_SEARCH + HEADER_LOOKAHEAD + 2 });
    if (!probe.records.length) return out;

    out.headerRow = findHeaderRow(probe.records, startAt);
    out.skippedLines = out.headerRow;
    out.columnCount = probe.records[out.headerRow] ? probe.records[out.headerRow].length : 0;
    return out;
  }

  function headerSignature(record) {
    return record.map(function (cell) {
      return fold(cell);
    }).join("\u0001");
  }

  /* A TOPLAM / TOTAL line carries a keyword and no date. Both halves are
     required: a real transaction row always has a date, so this cannot eat
     one, and a note that merely says "total" cannot trigger it either. */
  function looksLikeSummary(record) {
    var keyword = false;
    var dated = false;
    for (var i = 0; i < record.length; i += 1) {
      var cell = record[i];
      if (looksLikeDate(cell)) dated = true;
      var key = fold(cell);
      if (key && SUMMARY_WORDS[key]) keyword = true;
    }
    return keyword && !dated;
  }

  function parse(text, opts) {
    opts = opts || {};
    text = typeof text === "string" ? text : "";

    var delimiter = typeof opts.delimiter === "string" && opts.delimiter.length === 1
      ? opts.delimiter : null;
    var headerRow = typeof opts.headerRow === "number" && isFinite(opts.headerRow) && opts.headerRow >= 0
      ? Math.floor(opts.headerRow) : null;

    if (delimiter === null || headerRow === null) {
      var guess = sniff(text);
      if (delimiter === null) delimiter = guess.delimiter;
      if (headerRow === null) headerRow = guess.headerRow;
    }

    var out = {
      headers: [],
      rows: [],
      issues: [],
      rowLines: [],
      delimiter: delimiter,
      headerRow: headerRow,
      columnCount: 0,
      skipped: { blank: 0, repeatedHeader: 0, summaryRow: 0 },
      empty: true
    };
    if (!hasContent(text)) return out;
    out.empty = false;

    var cap = headerRow + MAX_ROWS + 2;
    var table = tokenize(text, delimiter, { maxRecords: cap });
    if (table.records.length >= cap) {
      throw fail("csv.tooManyRows", { limit: MAX_ROWS });
    }

    out.issues = table.issues.slice();

    if (headerRow >= table.records.length) return out;

    out.headers = table.records[headerRow].map(function (cell) {
      return String(cell === null || cell === undefined ? "" : cell).replace(/^﻿/, "").trim();
    });
    out.columnCount = out.headers.length;
    var signature = headerSignature(out.headers);

    for (var i = headerRow + 1; i < table.records.length; i += 1) {
      var record = table.records[i];
      var line = table.lines[i];

      if (isBlankRecord(record)) {
        out.skipped.blank += 1;
        continue;
      }
      if (headerSignature(record) === signature) {
        out.issues.push({ line: line, kind: "repeatedHeader" });
        out.skipped.repeatedHeader += 1;
        continue;
      }
      if (looksLikeSummary(record)) {
        out.issues.push({ line: line, kind: "summaryRow" });
        out.skipped.summaryRow += 1;
        continue;
      }

      if (record.length !== out.headers.length) {
        out.issues.push({ line: line, kind: "raggedRow" });
        /* Short rows are padded, long rows keep their tail: a ragged row is
           reported, never discarded and never silently trimmed. */
        while (record.length < out.headers.length) record.push("");
      }

      out.rows.push(record);
      out.rowLines.push(line);
    }

    return out;
  }

  /* ------------------------------------------------------- decimal voting */

  function numericShape(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[^0-9.,]/g, "");
  }

  /* Column-wide vote, because a single cell is often undecidable. The strong
     evidence is a value carrying both separators ("1.234,56": the last one is
     the decimal) or one separator twice ("1.234.567": thousands). */
  function detectDecimal(values) {
    if (!values || !values.length) return null;

    var decimalVotes = { ",": 0, ".": 0 };
    var strongGroup = { ",": 0, ".": 0 };

    for (var i = 0; i < values.length; i += 1) {
      var text = numericShape(values[i]);
      if (!/\d/.test(text)) continue;

      var comma = text.lastIndexOf(",");
      var dot = text.lastIndexOf(".");

      if (comma !== -1 && dot !== -1) {
        if (comma > dot) {
          decimalVotes[","] += 1;
          strongGroup["."] += 1;
        } else {
          decimalVotes["."] += 1;
          strongGroup[","] += 1;
        }
        continue;
      }

      var sep = comma !== -1 ? "," : (dot !== -1 ? "." : null);
      if (!sep) continue;

      var parts = text.split(sep);
      if (parts.length > 2) {
        strongGroup[sep] += 1;               /* 1.234.567 — grouping, certain */
        continue;
      }
      var tail = parts[1].length;
      if (tail === 1 || tail === 2 || tail > 3) decimalVotes[sep] += 1;
      /* tail === 3 is the classic ambiguity ("1.234"): no vote either way. */
    }

    if (decimalVotes[","] > decimalVotes["."]) return ",";
    if (decimalVotes["."] > decimalVotes[","]) return ".";

    if (decimalVotes[","] === 0 && decimalVotes["."] === 0) {
      if (strongGroup["."] > 0 && strongGroup[","] === 0) return ",";
      if (strongGroup[","] > 0 && strongGroup["."] === 0) return ".";
    }
    return null;                             /* undecidable: the wizard asks */
  }

  Moon.CSV = {
    MAX_BYTES: MAX_BYTES,
    MAX_ROWS: MAX_ROWS,
    DELIMITERS: DELIMITERS,
    ENCODINGS: ENCODINGS,
    read: read,
    decode: decode,
    sniff: sniff,
    parse: parse,
    detectDecimal: detectDecimal,
    /* Shared with importer.js, which needs the same shape test and the same
       fold for header matching. Not part of the public contract. */
    _fold: fold,
    _looksLikeDate: looksLikeDate
  };

  /* ------------------------------------------------------------- selftest */

  Moon.CSV._selftest = function () {
    var results = { total: 0, pass: 0, fail: 0, failures: [] };

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

    function bytesOf() {
      var list = [];
      for (var i = 0; i < arguments.length; i += 1) {
        var part = arguments[i];
        if (typeof part === "number") {
          list.push(part);
        } else {
          for (var j = 0; j < part.length; j += 1) list.push(part.charCodeAt(j) & 0xFF);
        }
      }
      return new Uint8Array(list);
    }

    /* 1 — Turkish statement: ";", "1.234,56", DD.MM.YYYY, CRLF. */
    var tr = "Tarih;Açıklama;Tutar;Bakiye\r\n"
      + "01.09.2026;MAAŞ ÖDEMESİ;38.500,00;41.230,55\r\n"
      + "02.09.2026;KİRA ÖDEMESİ;-14.000,00;27.230,55\r\n";
    var trSniff = sniff(tr);
    check("tr delimiter", trSniff.delimiter, ";");
    check("tr headerRow", trSniff.headerRow, 0);
    check("tr columnCount", trSniff.columnCount, 4);
    var trParsed = parse(tr, { delimiter: trSniff.delimiter, headerRow: trSniff.headerRow });
    check("tr headers", trParsed.headers, ["Tarih", "Açıklama", "Tutar", "Bakiye"]);
    check("tr rowCount", trParsed.rows.length, 2);
    check("tr amount cell", trParsed.rows[1][2], "-14.000,00");
    check("tr no issues", trParsed.issues.length, 0);
    check("tr decimal", detectDecimal(["38.500,00", "-14.000,00", "41.230,55"]), ",");

    /* 2 — English statement: ",", debit/credit, ISO dates, empty cells. */
    var en = "Date,Description,Debit,Credit\n"
      + "2026-09-01,Monthly salary,,3200.00\n"
      + "2026-09-02,Rent - September,1150.00,\n";
    var enSniff = sniff(en);
    check("en delimiter", enSniff.delimiter, ",");
    check("en columnCount", enSniff.columnCount, 4);
    var enParsed = parse(en, { delimiter: ",", headerRow: 0 });
    check("en credit cell", enParsed.rows[0][3], "3200.00");
    check("en empty debit", enParsed.rows[0][2], "");
    check("en trailing empty kept", enParsed.rows[1][3], "");
    check("en decimal", detectDecimal(["3200.00", "1150.00"]), ".");

    /* 3 — delimiter inside quotes must not split the row. */
    var quoted = "Tarih;Açıklama;Tutar\n06.09.2026;\"KAHVE DÜKKANI, KADIKÖY\";-165,00\n";
    var quotedParsed = parse(quoted, { delimiter: ";", headerRow: 0 });
    check("quoted width", quotedParsed.rows[0].length, 3);
    check("quoted note", quotedParsed.rows[0][1], "KAHVE DÜKKANI, KADIKÖY");
    var quotedComma = parse("a,b\n1,\"x,y\"\n", { delimiter: ",", headerRow: 0 });
    check("quoted comma", quotedComma.rows[0][1], "x,y");

    /* 4 — newline inside quotes stays in the field; the next row survives. */
    var multi = "Tarih;Açıklama;Tutar\n01.01.2026;\"iki\nsatır\";5,00\n02.01.2026;tek;6,00\n";
    var multiParsed = parse(multi, { delimiter: ";", headerRow: 0 });
    check("multiline rows", multiParsed.rows.length, 2);
    check("multiline field", multiParsed.rows[0][1], "iki\nsatır");
    check("multiline next row", multiParsed.rows[1][1], "tek");

    /* 5 — "" escape. */
    var escaped = parse("a;b;c\n1;\"say \"\"hi\"\" now\";3\n", { delimiter: ";", headerRow: 0 });
    check("escaped quote", escaped.rows[0][1], 'say "hi" now');

    /* 6 — UTF-8 BOM is stripped, not glued to the first header. */
    var bom = decode(bytesOf(0xEF, 0xBB, 0xBF, "Tarih;Tutar\n01.01.2026;5,00\n"));
    check("bom encoding", bom.encoding, "utf-8");
    check("bom first header", parse(bom.text, { delimiter: ";", headerRow: 0 }).headers[0], "Tarih");

    /* 7 — UTF-16LE BOM. */
    var u16 = [0xFF, 0xFE];
    "Tarih;Tutar\n1;2\n".split("").forEach(function (ch) {
      u16.push(ch.charCodeAt(0) & 0xFF, ch.charCodeAt(0) >> 8);
    });
    var wide = decode(new Uint8Array(u16));
    check("utf16 encoding", wide.encoding, "utf-16le");
    check("utf16 header", parse(wide.text, { delimiter: ";", headerRow: 0 }).headers, ["Tarih", "Tutar"]);

    /* 8 — windows-1254 bytes: invalid UTF-8, so the fallback and the warning. */
    var cp = decode(bytesOf("A", 0xE7, 0xFD, 0xFE, 0xF0, ";1,00\n"));
    check("cp1254 encoding", cp.encoding, "windows-1254");
    check("cp1254 warning", cp.warnings.indexOf("csv.encodingGuess") !== -1, true);
    if (typeof global.TextDecoder === "function") {
      check("cp1254 text", cp.text.slice(0, 5), "Açışğ");
    }

    /* 9 — Excel's sep= directive decides the delimiter and is not data. */
    var sepFile = "sep=;\nTarih;Tutar\n01.01.2026;5,00\n";
    var sepSniff = sniff(sepFile);
    check("sep delimiter", sepSniff.delimiter, ";");
    check("sep headerRow", sepSniff.headerRow, 1);
    check("sep skippedLines", sepSniff.skippedLines, 1);
    var sepParsed = parse(sepFile, { delimiter: sepSniff.delimiter, headerRow: sepSniff.headerRow });
    check("sep headers", sepParsed.headers, ["Tarih", "Tutar"]);
    check("sep rows", sepParsed.rows.length, 1);

    /* 10 — free text block before the header (every Turkish bank export). */
    var preamble = "ZIRAAT BANKASI\nHesap No: 1234-5678\nDonem: 01.09.2026 - 30.09.2026\n\n"
      + "Tarih;Aciklama;Tutar\n01.09.2026;X;5,00\n02.09.2026;Y;6,00\n03.09.2026;Z;7,00\n";
    var pre = sniff(preamble);
    check("preamble headerRow", pre.headerRow, 4);
    check("preamble skippedLines", pre.skippedLines, 4);
    check("preamble columnCount", pre.columnCount, 3);
    var preParsed = parse(preamble, { delimiter: pre.delimiter, headerRow: pre.headerRow });
    check("preamble rows", preParsed.rows.length, 3);

    /* 11 — header repeated mid-file (page break) is counted, not imported. */
    var repeated = "Tarih;Tutar\n01.01.2026;5,00\nTarih;Tutar\n02.01.2026;6,00\n";
    var repParsed = parse(repeated, { delimiter: ";", headerRow: 0 });
    check("repeated rows", repParsed.rows.length, 2);
    check("repeated issue", repParsed.issues[0], { line: 3, kind: "repeatedHeader" });

    /* 12 — trailing TOPLAM row skipped; a note saying "total" is untouched. */
    var totals = "Tarih;Aciklama;Tutar\n01.01.2026;X;5,00\nTOPLAM;;5,00\n";
    var totalsParsed = parse(totals, { delimiter: ";", headerRow: 0 });
    check("summary rows", totalsParsed.rows.length, 1);
    check("summary issue", totalsParsed.issues[0], { line: 3, kind: "summaryRow" });
    var notTotal = parse("Tarih;Aciklama;Tutar\n01.01.2026;toplam alisveris;5,00\n", { delimiter: ";", headerRow: 0 });
    check("summary false positive", notTotal.rows.length, 1);

    /* 13 — ragged rows are padded and reported, never dropped. */
    var ragged = "a;b;c\n1;2\n3;4;5;6\n";
    var raggedParsed = parse(ragged, { delimiter: ";", headerRow: 0 });
    check("ragged rows kept", raggedParsed.rows.length, 2);
    check("ragged padded", raggedParsed.rows[0], ["1", "2", ""]);
    check("ragged tail kept", raggedParsed.rows[1], ["3", "4", "5", "6"]);
    check("ragged issues", raggedParsed.issues.length, 2);

    /* 14 — unclosed quote: reported once, later rows recovered. */
    var broken = "Tarih;Aciklama;Tutar\n01.01.2026;\"bozuk;5,00\n02.01.2026;iyi;6,00\n";
    var brokenParsed = parse(broken, { delimiter: ";", headerRow: 0 });
    check("unclosed issue", brokenParsed.issues[0].kind, "unclosedQuote");
    check("unclosed line", brokenParsed.issues[0].line, 2);
    check("unclosed rows", brokenParsed.rows.length, 2);
    check("unclosed recovered", brokenParsed.rows[1], ["02.01.2026", "iyi", "6,00"]);

    /* 15 — empty and whitespace-only files. */
    check("empty sniff", sniff("").empty, true);
    check("blank sniff", sniff("\n\n  \n").empty, true);
    var emptyParsed = parse("");
    check("empty parse", { h: emptyParsed.headers.length, r: emptyParsed.rows.length }, { h: 0, r: 0 });

    /* 16 — CR-only line endings (old Mac exports, some POS printers). */
    var crParsed = parse("a;b\r1;2\r3;4\r", { delimiter: ";", headerRow: 0 });
    check("cr rows", crParsed.rows.length, 2);
    check("cr last", crParsed.rows[1], ["3", "4"]);

    /* 17 — tab and pipe. */
    check("tab delimiter", sniff("Date\tAmount\n2026-01-01\t5.00\n2026-01-02\t6.00\n").delimiter, "\t");
    check("pipe delimiter", sniff("Date|Amount\n2026-01-01|5.00\n2026-01-02|6.00\n").delimiter, "|");

    /* 18 — decimal voting, including the honest "I cannot tell". */
    check("decimal tr", detectDecimal(["1.234,56", "12,50"]), ",");
    check("decimal en", detectDecimal(["1,234.56", "12.50"]), ".");
    check("decimal grouped only", detectDecimal(["1.234", "2.345"]), null);
    check("decimal double group", detectDecimal(["1.234.567"]), ",");
    check("decimal plain", detectDecimal(["1234", "5678"]), null);
    check("decimal currency noise", detectDecimal(["₺1.234,56", "1.999,00 TL", "(19,90)"]), ",");
    check("decimal empty", detectDecimal([]), null);

    /* 19 — row ceiling is a hard, named error. */
    var many = "a;b\n";
    var chunk = [];
    for (var r = 0; r < MAX_ROWS + 2; r += 1) chunk.push("1;2");
    many += chunk.join("\n") + "\n";
    var rowError = null;
    try {
      parse(many, { delimiter: ";", headerRow: 0 });
    } catch (e) {
      rowError = e.key;
    }
    check("tooManyRows", rowError, "csv.tooManyRows");

    /* 20 — byte ceiling is a hard, named error. */
    var sizeError = null;
    try {
      decode(new Uint8Array(MAX_BYTES + 1));
    } catch (e) {
      sizeError = e.key;
    }
    check("tooLarge", sizeError, "csv.tooLarge");
    var zeroError = null;
    try {
      decode(new Uint8Array(0));
    } catch (e) {
      zeroError = e.key;
    }
    check("empty bytes", zeroError, "csv.empty");

    if (global.console) {
      global.console.log("Moon.CSV selftest: " + results.pass + "/" + results.total + " pass");
      results.failures.forEach(function (line) {
        global.console.log("  FAIL " + line);
      });
    }
    return results;
  };
})(window);
