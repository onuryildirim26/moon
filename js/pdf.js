/* Moon — reading a bank statement out of a PDF, with nothing installed.
 *
 * Banks hand out PDFs more often than CSVs, and retyping sixty rows is the
 * thing this app exists to avoid. A PDF library would be several megabytes of
 * code nobody here wrote, fetched from somewhere, and it would end the promise
 * that this page downloads nothing and runs from a file:// double-click. So the
 * reading is done here, and it is deliberately narrow.
 *
 * What it does:
 *   - walks the file for stream objects and inflates the FlateDecode ones with
 *     DecompressionStream, which the browser already has;
 *   - reads the text-showing operators out of the content streams, keeping the
 *     position of every run;
 *   - groups runs into lines by their y, splits each line into cells by the
 *     gaps in x, and hands back rows shaped exactly like Moon.CSV.parse's, so
 *     everything downstream — column guessing, duplicates, the review step —
 *     is the code that already works.
 *
 * What it does not do, and says so instead of guessing:
 *   - a scanned statement has no text to read, only a picture of one;
 *   - an encrypted file cannot be opened without its password;
 *   - a font with a private encoding can produce letters that are not the ones
 *     on the page, which is why the wizard shows the rows before anything is
 *     written.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var util = Moon.util || {};

  /* Limits. A statement is a few hundred kilobytes; anything far past that is
     not the thing we were handed. */
  var MAX_BYTES = 12 * 1024 * 1024;
  var MAX_STREAMS = 400;
  var MAX_RUNS = 60000;

  /* Two runs on the same line never differ in y by more than a rounding error;
     two lines are always further apart than this. Measured in PDF units, where
     a line of body text is about 12. */
  var LINE_TOLERANCE = 2.2;

  /* A gap wider than this between the end of one run and the start of the next
     is a column boundary rather than a word space. Also in PDF units; a space
     in 10pt text is about 2.5 wide. */
  var CELL_GAP = 7;

  /* An average glyph advance for body text, used only to guess where a run
     ends. Being a little wrong costs nothing: the split is decided by how the
     gaps on a line compare with each other, not by an absolute width. */
  var CHAR_WIDTH = 5.0;

  var ERR = {
    tooBig: "csv.err.tooBig",
    notPdf: "pdf.err.notPdf",
    encrypted: "pdf.err.encrypted",
    noText: "pdf.err.noText",
    readFailed: "csv.err.readFailed",
    internal: "csv.internal"
  };

  /* ------------------------------------------------------------ bytes --- */

  function bytesOf(file) {
    return new global.Promise(function (resolve, reject) {
      if (!file) return reject(fail(ERR.notPdf));
      if (file.size > MAX_BYTES) return reject(fail(ERR.tooBig, { size: file.size }));

      var reader = new global.FileReader();
      reader.onerror = function () { reject(fail(ERR.readFailed)); };
      reader.onload = function () { resolve(new global.Uint8Array(reader.result)); };
      /* readAsArrayBuffer, not fetch: this has to work from file:// too. */
      reader.readAsArrayBuffer(file);
    });
  }

  function fail(key, params) {
    var error = new Error(key);
    error.key = key;
    error.params = params || null;
    return error;
  }

  /* Latin-1 rather than UTF-8 on purpose: a PDF's structure is bytes, and
     treating a 0x80-0xFF byte as its own character keeps offsets honest. */
  function latin1(bytes, from, to) {
    var out = "";
    var end = Math.min(to === undefined ? bytes.length : to, bytes.length);
    for (var i = from || 0; i < end; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function indexOfBytes(bytes, needle, from) {
    var first = needle.charCodeAt(0);
    var limit = bytes.length - needle.length;
    for (var i = from || 0; i <= limit; i += 1) {
      if (bytes[i] !== first) continue;
      var hit = true;
      for (var j = 1; j < needle.length; j += 1) {
        if (bytes[i + j] !== needle.charCodeAt(j)) { hit = false; break; }
      }
      if (hit) return i;
    }
    return -1;
  }

  /* ---------------------------------------------------------- inflate --- */

  function inflate(bytes) {
    if (typeof global.DecompressionStream !== "function") {
      return global.Promise.reject(fail(ERR.internal));
    }
    /* PDF's FlateDecode is zlib-wrapped, which is "deflate" here; a few writers
       emit it raw, so that is the second guess rather than a failure. */
    return tryInflate(bytes, "deflate").catch(function () {
      return tryInflate(bytes, "deflate-raw");
    });
  }

  function tryInflate(bytes, format) {
    return new global.Promise(function (resolve, reject) {
      var stream;
      try {
        stream = new global.DecompressionStream(format);
      } catch (error) {
        reject(error);
        return;
      }

      var writer = stream.writable.getWriter();
      /* The writer rejects for the same reason the reader does, and an
         unhandled one of these takes the whole page down rather than costing us
         a single unreadable stream. Both ends are answered. */
      writer.write(bytes).catch(function () {});
      writer.close().catch(function () {});

      var reader = stream.readable.getReader();
      var chunks = [];
      var total = 0;

      function pump() {
        reader.read().then(function (step) {
          if (step.done) {
            var out = new global.Uint8Array(total);
            var at = 0;
            chunks.forEach(function (chunk) { out.set(chunk, at); at += chunk.length; });
            resolve(out);
            return;
          }
          chunks.push(step.value);
          total += step.value.length;
          pump();
        }, reject);
      }
      pump();
    });
  }

  /* ---------------------------------------------------------- streams --- */

  function isEncrypted(bytes) {
    /* /Encrypt in the trailer means every string and stream is enciphered. We
       do not attempt a password, so the only honest move is to say so. */
    return indexOfBytes(bytes, "/Encrypt") !== -1;
  }

  function collectStreams(bytes) {
    var out = [];
    var at = 0;

    while (out.length < MAX_STREAMS) {
      var start = indexOfBytes(bytes, "stream", at);
      if (start === -1) break;

      /* The dictionary that describes this stream is whatever precedes it. */
      var dictFrom = Math.max(0, start - 600);
      var dict = latin1(bytes, dictFrom, start);

      var body = start + "stream".length;
      if (bytes[body] === 13) body += 1;      /* CR */
      if (bytes[body] === 10) body += 1;      /* LF */

      var end = indexOfBytes(bytes, "endstream", body);
      if (end === -1) break;

      /* The spec puts an end-of-line before "endstream" and it is not part of
         the data. A strict inflater — which every browser's is — stops at the
         end of the compressed run and calls whatever follows junk. */
      var stop = end;
      while (stop > body && (bytes[stop - 1] === 10 || bytes[stop - 1] === 13)) stop -= 1;

      out.push({
        flate: /\/FlateDecode/.test(dict),
        /* An image is a stream too, and inflating one only to find no text in
           it is wasted work on a big file. */
        image: /\/Subtype\s*\/Image/.test(dict),
        bytes: bytes.subarray(body, stop)
      });

      at = end + "endstream".length;
    }
    return out;
  }

  function decodeStreams(streams) {
    var texts = [];

    function step(i) {
      if (i >= streams.length) return global.Promise.resolve(texts);
      var stream = streams[i];

      if (stream.image) return step(i + 1);
      if (!stream.flate) {
        texts.push(latin1(stream.bytes));
        return step(i + 1);
      }
      return inflate(stream.bytes).then(function (out) {
        texts.push(latin1(out));
        return step(i + 1);
      }).catch(function () {
        /* One unreadable stream is not a broken file: a statement's text is
           spread over many, and the rest may read perfectly. */
        return step(i + 1);
      });
    }
    return step(0);
  }

  /* ------------------------------------------------------------- text --- */

  var ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

  /* A PDF literal string: (like this), with escapes and octal codes. */
  function readLiteral(source, from) {
    var out = "";
    var depth = 1;
    var i = from;

    while (i < source.length) {
      var ch = source.charAt(i);

      if (ch === "\\") {
        var next = source.charAt(i + 1);
        if (ESCAPES[next] !== undefined) { out += ESCAPES[next]; i += 2; continue; }
        if (next >= "0" && next <= "7") {
          var octal = next;
          var j = i + 2;
          while (j < source.length && octal.length < 3 && source.charAt(j) >= "0" && source.charAt(j) <= "7") {
            octal += source.charAt(j);
            j += 1;
          }
          out += String.fromCharCode(parseInt(octal, 8));
          i = j;
          continue;
        }
        if (next === "\n") { i += 2; continue; }   /* a line continuation */
        out += next;
        i += 2;
        continue;
      }

      if (ch === "(") { depth += 1; out += ch; i += 1; continue; }
      if (ch === ")") {
        depth -= 1;
        if (!depth) return { text: out, next: i + 1 };
        out += ch;
        i += 1;
        continue;
      }

      out += ch;
      i += 1;
    }
    return { text: out, next: i };
  }

  /* A hex string: <48656c6c6f>. Two digits per byte; UTF-16BE when it opens
     with a byte order mark, which is how accented names usually arrive. */
  function readHex(source, from, cmap) {
    var digits = "";
    var i = from;
    while (i < source.length && source.charAt(i) !== ">") {
      var ch = source.charAt(i);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
      i += 1;
    }
    if (digits.length % 2) digits += "0";

    var bytes = [];
    for (var j = 0; j < digits.length; j += 2) {
      bytes.push(parseInt(digits.substr(j, 2), 16));
    }

    return { text: decodeCodes(bytes, cmap), next: i + 1 };
  }

  /* Turns the bytes of a shown string into letters. Which rule applies depends
     on what the file gave us: a font's own map if there is one, a byte order
     mark if the writer used UTF-16, and otherwise the bytes themselves. */
  function decodeCodes(bytes, cmap) {
    if (cmap && cmap.size) {
      var width = cmap.width > 1 ? 2 : 1;
      var out = "";
      for (var i = 0; i + width - 1 < bytes.length; i += width) {
        var code = width === 2 ? ((bytes[i] << 8) | bytes[i + 1]) : bytes[i];
        var mapped = cmap.map[code];
        if (mapped !== undefined) out += mapped;
        /* A code the map does not know is a glyph we cannot name. Printing a
           replacement would put noise in the reader's ledger, so it is left
           out and the preview shows the gap. */
      }
      return out;
    }

    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      var utf = "";
      for (var k = 2; k + 1 < bytes.length; k += 2) {
        utf += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
      }
      return utf;
    }

    var plain = "";
    bytes.forEach(function (code) { plain += String.fromCharCode(code); });
    return plain;
  }

  /* Walks one content stream and returns every run of shown text with the
     position it was shown at. Only the operators that move the pen or print
     are understood; everything else is skipped, which is why a page of vector
     graphics costs nothing here. */
  function runsFrom(content, page, into, cmap) {
    var x = 0, y = 0;         /* the text line's origin */
    var lead = 0;             /* leading, for T* */
    var pending = "";
    var pendingX = 0;
    var stack = [];
    var i = 0;

    function flush() {
      if (!pending) return;
      if (into.length < MAX_RUNS) {
        into.push({ page: page, x: pendingX, y: y, text: pending, order: into.length });
      }
      pending = "";
    }

    function numbers(count) {
      var out = stack.slice(-count).map(Number);
      while (out.length < count) out.unshift(0);
      return out.map(function (n) { return isFinite(n) ? n : 0; });
    }

    while (i < content.length) {
      var ch = content.charAt(i);

      if (ch === "(") {
        var literal = readLiteral(content, i + 1);
        if (!pending) pendingX = x;
        /* A literal in a subset font carries the same glyph codes a hex string
           would, so it takes the same road back to letters. */
        pending += cmap && cmap.size ? decodeCodes(codesOf(literal.text), cmap) : literal.text;
        i = literal.next;
        continue;
      }

      if (ch === "<" && content.charAt(i + 1) !== "<") {
        var hex = readHex(content, i + 1, cmap);
        if (!pending) pendingX = x;
        pending += hex.text;
        i = hex.next;
        continue;
      }

      /* A number or a name: collect it as an operand. */
      if (/[-+.\d]/.test(ch)) {
        var num = "";
        while (i < content.length && /[-+.\d]/.test(content.charAt(i))) {
          num += content.charAt(i);
          i += 1;
        }
        stack.push(num);
        if (stack.length > 8) stack.shift();
        continue;
      }

      if (/[A-Za-z'"*]/.test(ch)) {
        var op = "";
        while (i < content.length && /[A-Za-z0-9*'"]/.test(content.charAt(i))) {
          op += content.charAt(i);
          i += 1;
        }

        if (op === "Td" || op === "TD") {
          flush();
          var td = numbers(2);
          x += td[0];
          y += td[1];
          if (op === "TD") lead = -td[1];
          stack = [];
          continue;
        }
        if (op === "Tm") {
          flush();
          var tm = numbers(6);
          x = tm[4];
          y = tm[5];
          stack = [];
          continue;
        }
        if (op === "TL") { lead = numbers(1)[0]; stack = []; continue; }
        if (op === "T") { stack = []; continue; }
        if (op === "Tstar" || op === "T*") {
          flush();
          y -= lead;
          stack = [];
          continue;
        }
        if (op === "BT") { flush(); x = 0; y = 0; stack = []; continue; }
        if (op === "ET" || op === "Tj" || op === "TJ") { flush(); stack = []; continue; }
        if (op === "'" || op === '"') { flush(); y -= lead; stack = []; continue; }

        stack = [];
        continue;
      }

      i += 1;
    }
    flush();
  }

  function codesOf(text) {
    var out = [];
    for (var i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xFF);
    return out;
  }

  /* ------------------------------------------------------------ cmap --- */

  /* A subset font carries glyph numbers, not letters: "01.09" arrives as the
     codes the font happens to have assigned, which is why the raw bytes of a
     printed PDF read as nonsense. The translation is in the file — every such
     font ships a /ToUnicode CMap, which inflates to plain text listing either
     single codes (bfchar) or runs of them (bfrange).
     The maps of every font are merged into one. Two subsets of the same family
     agree on their codes, and where they would not, the wizard shows the rows
     before anything is written. */
  function readCMap(text, into) {
    var pairs = /beginbfchar([\s\S]*?)endbfchar/g;
    var ranges = /beginbfrange([\s\S]*?)endbfrange/g;
    var hex = /<([0-9a-fA-F]+)>/g;
    var found = 0;
    var block;

    while ((block = pairs.exec(text))) {
      var tokens = block[1].match(hex);
      if (!tokens) continue;
      for (var i = 0; i + 1 < tokens.length; i += 2) {
        var from = tokens[i].slice(1, -1);
        var to = tokens[i + 1].slice(1, -1);
        into.map[parseInt(from, 16)] = fromUtf16(to);
        into.width = Math.max(into.width, from.length / 2);
        found += 1;
      }
    }

    while ((block = ranges.exec(text))) {
      var body = block[1];
      /* <lo> <hi> <dst>  — a run that maps straight through */
      var simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      var row;
      while ((row = simple.exec(body))) {
        var lo = parseInt(row[1], 16);
        var hi = parseInt(row[2], 16);
        var base = parseInt(row[3], 16);
        if (hi - lo > 4096) continue;
        for (var code = lo; code <= hi; code += 1) {
          into.map[code] = String.fromCharCode(base + (code - lo));
          found += 1;
        }
        into.width = Math.max(into.width, row[1].length / 2);
      }

      /* <lo> <hi> [ <d1> <d2> … ] — a run spelled out one destination at a time */
      var listed = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
      while ((row = listed.exec(body))) {
        var start = parseInt(row[1], 16);
        var items = row[3].match(hex) || [];
        items.forEach(function (item, index) {
          into.map[start + index] = fromUtf16(item.slice(1, -1));
          found += 1;
        });
        into.width = Math.max(into.width, row[1].length / 2);
      }
    }

    into.size += found;
    return found;
  }

  function fromUtf16(hexDigits) {
    var out = "";
    for (var i = 0; i + 3 < hexDigits.length + 1; i += 4) {
      var unit = parseInt(hexDigits.substr(i, 4), 16);
      if (isFinite(unit) && unit) out += String.fromCharCode(unit);
    }
    return out;
  }

  /* --------------------------------------------------------- the table --- */

  /* PDF's own axis points up, but a writer is free to hand down a flipped
     matrix, and browsers printing to PDF do. Rather than assume, ask the file:
     content is emitted in roughly reading order, so whichever direction agrees
     with the order the runs arrived in is the direction the page reads. */
  function downwards(runs) {
    var falls = 0;
    var climbs = 0;
    for (var i = 1; i < runs.length; i += 1) {
      var delta = runs[i].y - runs[i - 1].y;
      if (Math.abs(delta) <= LINE_TOLERANCE) continue;
      if (delta > 0) climbs += 1;
      else falls += 1;
    }
    /* climbs means later text sits at a higher y, so y grows downward. */
    return climbs > falls;
  }

  function toLines(runs) {
    var down = downwards(runs);
    var sorted = runs.slice().sort(function (a, b) {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y - b.y) > LINE_TOLERANCE) return down ? a.y - b.y : b.y - a.y;
      if (a.x !== b.x) return a.x - b.x;
      return a.order - b.order;
    });

    var lines = [];
    var current = null;

    sorted.forEach(function (run) {
      var text = String(run.text || "");
      if (!text.trim()) return;

      if (!current || current.page !== run.page || Math.abs(current.y - run.y) > LINE_TOLERANCE) {
        current = { page: run.page, y: run.y, runs: [] };
        lines.push(current);
      }
      current.runs.push(run);
    });

    return lines;
  }

  /* Splits a line into cells wherever the pen jumped further than a word space.
     This is what makes a PDF table a table: the columns are in the geometry,
     not in any delimiter. */
  /* Where one cell ends and the next begins is a question about this document,
     not about PDF: a space between two words and the space between two columns
     are both just gaps, and which is which depends on the type size the bank
     used. So the gaps on a line are measured, and the split happens at the ones
     that stand out from the rest — with a floor, so a line of evenly spaced
     words is not chopped into letters. */
  /* How wide a character is in this file, measured rather than assumed. A
     printer that emits one run per glyph gives the advance directly: the step
     from one run's origin to the next, over the characters in between. Guessing
     it wrong is what turns "01.09.2026" into "0 1 .0 9". */
  function advanceOf(lines) {
    var samples = [];
    lines.forEach(function (line) {
      for (var i = 1; i < line.runs.length; i += 1) {
        var previous = line.runs[i - 1];
        var length = String(previous.text || "").length;
        if (!length) continue;
        var step = (line.runs[i].x - previous.x) / length;
        if (step > 0.5 && step < 40) samples.push(step);
      }
    });
    if (!samples.length) return CHAR_WIDTH;
    samples.sort(function (a, b) { return a - b; });
    return samples[Math.floor(samples.length / 2)];
  }

  function cellsOf(line, advance) {
    var width = advance > 0 ? advance : CHAR_WIDTH;
    /* A space is about one character wide; a column is several. Both are read
       against the advance this file actually uses. */
    var spaceAt = width * 0.52;
    var threshold = Math.max(CELL_GAP, width * 2.6);
    var cells = [];
    var text = "";
    var lastEnd = null;

    line.runs.forEach(function (run) {
      var body = String(run.text || "");
      if (lastEnd !== null) {
        var gap = run.x - lastEnd;
        if (gap > threshold) {
          if (text.trim()) cells.push(text.trim());
          text = "";
        } else if (gap > spaceAt && text) {
          /* Same cell, but the words were set apart: keep the space. */
          text += " ";
        }
      }
      text += body;
      lastEnd = run.x + body.length * width;
    });

    if (text.trim()) cells.push(text.trim());
    return cells;
  }

  /* -------------------------------------------------------------- read --- */

  /**
   * Reads a statement out of a PDF.
   * @returns {Promise<{headers: string[], rows: string[][], lines: number,
   *                    pages: number, warnings: string[]}>}
   */
  function read(file) {
    return bytesOf(file).then(function (bytes) {
      var head = latin1(bytes, 0, 1024);
      if (head.indexOf("%PDF") === -1) throw fail(ERR.notPdf);
      if (isEncrypted(bytes)) throw fail(ERR.encrypted);

      var streams = collectStreams(bytes);
      if (!streams.length) throw fail(ERR.noText);

      return decodeStreams(streams).then(function (texts) {
        /* The maps have to be in hand before a single run is read, and they
           arrive in their own streams anywhere in the file. */
        var cmap = { map: {}, width: 1, size: 0 };
        texts.forEach(function (content) {
          if (content.indexOf("beginbfchar") === -1 && content.indexOf("beginbfrange") === -1) return;
          readCMap(content, cmap);
        });

        var runs = [];
        texts.forEach(function (content, page) {
          if (content.indexOf("Tj") === -1 && content.indexOf("TJ") === -1) return;
          runsFrom(content, page, runs, cmap);
        });

        if (!runs.length) throw fail(ERR.noText);

        var lines = toLines(runs);
        var advance = advanceOf(lines);
        var table = lines.map(function (line) {
          return cellsOf(line, advance);
        }).filter(function (cells) { return cells.length > 0; });
        if (!table.length) throw fail(ERR.noText);

        /* The header is the first line whose shape the lines under it repeat —
           the same rule CSV.sniff uses, for the same reason: a statement opens
           with the bank's name and the account number, and none of that is the
           table. */
        var headerAt = findHeader(table);
        var headers = table[headerAt] || [];
        var rows = table.slice(headerAt + 1).filter(function (cells) {
          return cells.length > 1;
        });

        var warnings = [];
        if (rows.length < 2) warnings.push("pdf.warn.fewRows");

        return {
          headers: headers,
          rows: normalise(rows, headers.length),
          lines: table.length,
          pages: texts.length,
          warnings: warnings
        };
      });
    });
  }

  function findHeader(table) {
    for (var i = 0; i < Math.min(table.length, 40); i += 1) {
      var width = table[i].length;
      if (width < 2) continue;
      var same = 0;
      for (var j = i + 1; j < Math.min(table.length, i + 5); j += 1) {
        if (Math.abs(table[j].length - width) <= 1) same += 1;
      }
      if (same >= 2) return i;
    }
    return 0;
  }

  function normalise(rows, width) {
    if (!(width > 0)) return rows;
    return rows.map(function (cells) {
      var out = cells.slice(0, Math.max(width, cells.length));
      while (out.length < width) out.push("");
      return out;
    });
  }

  /* ---------------------------------------------------------- selftest --- */

  function selftest() {
    var failures = [];
    var checks = 0;

    function check(name, got, want) {
      checks += 1;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(name + ": wanted " + JSON.stringify(want) + ", got " + JSON.stringify(got));
      }
    }

    check("literal string", readLiteral("Merhaba)", 0).text, "Merhaba");
    check("literal escape", readLiteral("a\\(b)", 0).text, "a(b");
    check("literal octal", readLiteral("\\101)", 0).text, "A");
    check("nested parens", readLiteral("a(b)c)", 0).text, "a(b)c");
    check("hex string", readHex("4D6F6F6E>", 0).text, "Moon");
    check("hex utf16", readHex("FEFF004D006F>", 0).text, "Mo");

    var runs = [];
    runsFrom("BT /F1 10 Tf 72 700 Td (Tarih) Tj 200 0 Td (Tutar) Tj ET", 0, runs);
    check("two runs read", runs.length, 2);
    check("first run text", runs[0] && runs[0].text, "Tarih");
    check("second run moved", runs[1] && runs[1].x, 272);

    var lines = toLines([
      { page: 0, x: 72, y: 700, text: "01.09.2026" },
      { page: 0, x: 200, y: 700, text: "MAAS" },
      { page: 0, x: 400, y: 700, text: "38.500,00" },
      { page: 0, x: 72, y: 688, text: "02.09.2026" }
    ]);
    check("lines grouped by y", lines.length, 2);
    check("cells split by gap", cellsOf(lines[0], 4.6), ["01.09.2026", "MAAS", "38.500,00"]);

    var tight = toLines([
      { page: 0, x: 72, y: 700, text: "KAHVE" },
      { page: 0, x: 100, y: 700, text: "DUKKANI" }
    ]);
    check("a word space is not a column", cellsOf(tight[0], 4.6).length, 1);

    check("header found under a preamble", findHeader([
      ["MEGA BANK"],
      ["Hesap: 4471"],
      ["Tarih", "Aciklama", "Tutar"],
      ["01.09.2026", "MAAS", "38.500,00"],
      ["02.09.2026", "KIRA", "-14.000,00"],
      ["03.09.2026", "MARKET", "-1.847,60"]
    ]), 2);

    check("short rows are padded", normalise([["a", "b"]], 3), [["a", "b", ""]]);

    return { ok: !failures.length, checks: checks, failures: failures };
  }

  Moon.PDF = {
    read: read,
    MAX_BYTES: MAX_BYTES,
    /* Exposed for the wizard's own messages and for the tests. */
    _runsFrom: runsFrom,
    _toLines: toLines,
    _cellsOf: cellsOf,
    _findHeader: findHeader,
    _selftest: selftest
  };
})(window);
