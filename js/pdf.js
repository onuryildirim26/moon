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
 *   - reads the font metrics the file already carries, so the width of a run of
 *     text is measured rather than guessed;
 *   - reads the text-showing operators out of the content streams, keeping the
 *     position and the measured width of every run;
 *   - groups runs into lines by their y, joins a header cell that wraps over
 *     several lines back into one row, splits each row into cells by the gaps
 *     in x, and hands back rows shaped exactly like Moon.CSV.parse's, so
 *     everything downstream — column guessing, duplicates, the review step —
 *     is the code that already works;
 *   - and reads the same page a second way, line by line, looking only for a
 *     date and an amount, because a bank whose grid does not line up is still
 *     a statement a person can read at a glance.
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

  /* An indirect object's dictionary is a line or two, except for a font's width
     table, which runs to a few hundred numbers. Reading this far past the "obj"
     keyword reaches the whole dictionary and stops well short of the stream
     body that may follow it. */
  var MAX_OBJECTS = 4000;
  var MAX_OBJECT_BODY = 4096;

  /* Two runs on the same line never differ in y by more than a rounding error;
     two lines are always further apart than this. Measured in PDF units, where
     a line of body text is about 12. */
  var LINE_TOLERANCE = 2.2;

  /* A gap wider than this between the end of one run and the start of the next
     is a column boundary rather than a word space. Also in PDF units; a space
     in 10pt text is about 2.5 wide. */
  var CELL_GAP = 7;

  /* An average glyph advance for body text, used only when a font's own widths
     cannot be read. Being a little wrong costs nothing: the split is decided by
     how the gaps on a line compare with each other, not by an absolute width. */
  var CHAR_WIDTH = 5.0;

  /* Glyph advances in a PDF are given in thousandths of the type size, which is
     the unit both /Widths and /W are written in. */
  var GLYPH_UNITS = 1000;

  /* Fractions of the type size, which is what the font metrics let us work in.
     A space is about a quarter of an em in every typeface a bank uses, but the
     pair kerning around it can eat a third of that — "KIRA TRANSFERI" leaves
     only 0.20 em between the A and the T — so the bar for a space sits lower
     than a space actually is. A column is more than a whole em away. */
  var SPACE_SHARE = 0.16;
  var COLUMN_SHARE = 1.2;

  /* How close two lines have to be before the second is read as the wrapped
     remainder of the first rather than as a line of its own — as a share of the
     type size, and never more than this share of the page's own line pitch. */
  var WRAP_SHARE = 1.35;
  var WRAP_PITCH_SHARE = 0.95;

  /* A page with pictures on it and less text than this is a scan, or a
     statement re-rendered by a phone app: a picture of a table. */
  var SCAN_CHARS = 200;

  /* And so is a page that carries this many bytes of picture for every
     character of text. A phone app's export puts a third of a megabyte of
     bitmap behind three hundred characters of heading; a text statement with a
     logo on it carries thirty bytes of picture per character. */
  var SCAN_WEIGHT = 200;

  var ERR = {
    tooBig: "csv.err.tooBig",
    notPdf: "pdf.err.notPdf",
    encrypted: "pdf.err.encrypted",
    noText: "pdf.err.noText",
    scanned: "pdf.err.scanned",
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

  function isDigitByte(code) { return code >= 48 && code <= 57; }

  function isSpaceByte(code) {
    return code === 32 || code === 10 || code === 13 || code === 9 || code === 12 || code === 0;
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

      /* The dictionary that describes this stream is whatever stands between
         the enclosing object's own "obj" keyword and the stream itself. Taking
         the whole window instead would read the previous object's dictionary as
         well, and a page of text sitting next to an image would then be thrown
         away as an image. */
      var before = latin1(bytes, Math.max(0, start - 1200), start);
      var marker = null;
      var markers = /(\d+)\s+(\d+)\s+obj/g;
      var step;
      while ((step = markers.exec(before))) marker = step;
      var dict = marker ? before.slice(marker.index + marker[0].length) : before;
      var num = marker ? parseInt(marker[1], 10) : 0;

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
        num: isFinite(num) ? num : 0,
        dict: dict,
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

  /* One entry per stream, in the same order, so a content stream can be matched
     back to the dictionary that names its fonts. An image, or a stream that
     will not inflate, leaves a null behind rather than shifting the rest. */
  function decodeStreams(streams) {
    var texts = [];

    function step(i) {
      if (i >= streams.length) return global.Promise.resolve(texts);
      var stream = streams[i];

      if (stream.image) { texts.push(null); return step(i + 1); }
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
        texts.push(null);
        return step(i + 1);
      });
    }
    return step(0);
  }

  /* ---------------------------------------------------------- objects --- */

  /* Every indirect object in the file, by number, as far as its dictionary. The
     font metrics are in these dictionaries, and nothing else here needs the
     stream bodies, so the body is left in the bytes where it already is. */
  function objectIndex(bytes) {
    var index = {};
    var at = 0;
    var found = 0;

    while (found < MAX_OBJECTS) {
      var hit = indexOfBytes(bytes, "obj", at);
      if (hit === -1) break;
      at = hit + 3;

      /* An object opens with its number and its generation, so the keyword is
         read backwards. "endobj" ends with the same three letters and fails
         this walk at the first step, which is how the two are told apart. */
      var i = hit - 1;
      while (i >= 0 && isSpaceByte(bytes[i])) i -= 1;
      var generationTo = i;
      while (i >= 0 && isDigitByte(bytes[i])) i -= 1;
      if (i === generationTo) continue;
      var generationFrom = i;
      while (i >= 0 && isSpaceByte(bytes[i])) i -= 1;
      if (i === generationFrom) continue;
      var numberTo = i;
      while (i >= 0 && isDigitByte(bytes[i])) i -= 1;
      if (i === numberTo) continue;

      var num = parseInt(latin1(bytes, i + 1, numberTo + 1), 10);
      if (!isFinite(num)) continue;
      found += 1;
      if (index[num] !== undefined) continue;

      /* The bytes of a compressed font can spell "12 0 obj" by chance, and an
         imaginary object 12 would then hide the real one. Everything this
         reader follows is a dictionary or an array, so anything else is left
         out and a chance hit in the middle of a stream almost never looks like
         either. */
      var body = bodyAt(bytes, hit + 3);
      if (!/^\s*(<<|\[)/.test(body)) continue;
      index[num] = body;
    }
    return index;
  }

  function bodyAt(bytes, from) {
    var text = latin1(bytes, from, from + MAX_OBJECT_BODY);
    var end = text.length;
    var endobj = text.indexOf("endobj");
    if (endobj !== -1) end = endobj;
    var stream = text.indexOf("stream");
    if (stream !== -1 && stream < end) end = stream;
    return text.slice(0, end);
  }

  /* From PDF 1.5 on, a writer may pack most of its objects into one compressed
     stream. The font dictionaries of such a file are not in the bytes at all,
     so the packed streams are unpacked and indexed the same way. */
  function indexObjectStreams(streams, texts, index) {
    streams.forEach(function (stream, at) {
      var text = texts[at];
      if (!text || !/\/Type\s*\/ObjStm/.test(stream.dict)) return;

      var count = /\/N\s+(\d+)/.exec(stream.dict);
      var first = /\/First\s+(\d+)/.exec(stream.dict);
      if (!count || !first) return;

      var total = Math.min(parseInt(count[1], 10), MAX_OBJECTS);
      var base = parseInt(first[1], 10);
      if (!isFinite(total) || !isFinite(base)) return;

      /* The stream opens with a table of object numbers and offsets, in pairs,
         and the objects themselves follow it from /First on. */
      var pairs = text.slice(0, base).match(/\d+/g) || [];
      for (var i = 0; i + 1 < pairs.length && i < total * 2; i += 2) {
        var num = parseInt(pairs[i], 10);
        var offset = parseInt(pairs[i + 1], 10);
        if (!isFinite(num) || !isFinite(offset)) continue;
        if (index[num] !== undefined) continue;
        index[num] = text.substr(base + offset, MAX_OBJECT_BODY);
      }
    });
  }

  /* The text between a bracket and the one that closes it, so a width array or
     a resource dictionary can be lifted out whole however deeply it nests. */
  function balanced(text, from, open, close) {
    var depth = 0;
    var i = from;

    while (i < text.length) {
      var ch = text.charAt(i);

      /* A string may hold a bare bracket, and a hex string's own angles would
         otherwise be counted as a dictionary's. */
      if (ch === "(") { i = readLiteral(text, i + 1).next; continue; }
      if (ch === "<" && text.charAt(i + 1) !== "<") {
        var shut = text.indexOf(">", i + 1);
        i = shut === -1 ? text.length : shut + 1;
        continue;
      }

      if (text.substr(i, open.length) === open) {
        depth += 1;
        i += open.length;
        continue;
      }
      if (text.substr(i, close.length) === close) {
        depth -= 1;
        if (depth <= 0) return text.slice(from + open.length, i);
        i += close.length;
        continue;
      }
      i += 1;
    }
    return "";
  }

  /* Where the value of /Key starts. The name has to end: a search for /W must
     not find /Widths, and a search for /Font must not find /FontDescriptor. */
  function keyAt(source, key) {
    var found = new RegExp("\\/" + key + "(?![A-Za-z0-9])").exec(source || "");
    return found ? found.index + found[0].length : -1;
  }

  function bracketedValue(source, key, index, open, close) {
    var at = keyAt(source, key);
    if (at === -1) return "";

    var ahead = source.slice(at, at + 64);
    var opener = new RegExp("^\\s*" + (open === "[" ? "\\[" : "<<")).exec(ahead);
    if (opener) return balanced(source, at + opener[0].length - open.length, open, close);

    /* The writer is free to put the value in an object of its own. */
    var reference = /^\s*(\d+)\s+\d+\s+R/.exec(ahead);
    if (!reference || !index) return "";
    var body = index[parseInt(reference[1], 10)];
    if (!body) return "";
    var inner = new RegExp(open === "[" ? "\\[" : "<<").exec(body);
    return inner ? balanced(body, inner.index, open, close) : "";
  }

  function arrayValue(source, key, index) {
    return bracketedValue(source, key, index, "[", "]");
  }

  function dictionaryValue(source, key, index) {
    return bracketedValue(source, key, index, "<<", ">>");
  }

  function numberValue(source, key) {
    var at = keyAt(source, key);
    if (at === -1) return null;
    var found = /^\s*(-?[\d.]+)/.exec(source.slice(at, at + 32));
    if (!found) return null;
    var value = Number(found[1]);
    return isFinite(value) ? value : null;
  }

  function referenceValue(source, key) {
    var at = keyAt(source, key);
    if (at === -1) return null;
    var found = /^\s*(\d+)\s+\d+\s+R/.exec(source.slice(at, at + 32));
    return found ? parseInt(found[1], 10) : null;
  }

  /* ------------------------------------------------------------ fonts --- */

  /* How wide this font's glyphs are, in thousandths of the type size. Every PDF
     carries it: a simple font lists /Widths from /FirstChar on, and a CID font
     lists /W in runs. Reading it is the whole difference between knowing where
     a run of text ends and guessing. */
  function fontMetrics(index, num, seen) {
    var body = index[num];
    if (!body || seen[num]) return null;
    seen[num] = true;

    if (/\/Subtype\s*\/Type0/.test(body)) {
      /* A Type0 font keeps its metrics one level down, in the CIDFont it
         descends to, and addresses its glyphs with two bytes per code. */
      var descendants = arrayValue(body, "DescendantFonts", index);
      var reference = /(\d+)\s+\d+\s+R/.exec(descendants);
      var inner = reference ? index[parseInt(reference[1], 10)] : descendants;
      if (!inner) return null;

      var cids = parseWidths(arrayValue(inner, "W", index), {});
      var fallback = numberValue(inner, "DW");
      var listed = false;
      var cid;
      for (cid in cids) { if (cids.hasOwnProperty(cid)) { listed = true; break; } }
      if (!listed && fallback === null) return null;

      return {
        bytes: 2,
        widths: cids,
        missing: fallback === null ? GLYPH_UNITS : fallback,
        known: true
      };
    }

    var list = arrayValue(body, "Widths", index);
    var numbers = list ? (list.match(/-?[\d.]+/g) || []) : [];
    if (!numbers.length) return null;

    var first = numberValue(body, "FirstChar");
    var widths = {};
    var from = first === null ? 0 : first;
    numbers.forEach(function (value, at) { widths[from + at] = Number(value); });

    var descriptor = referenceValue(body, "FontDescriptor");
    var missing = descriptor !== null && index[descriptor] !== undefined
      ? numberValue(index[descriptor], "MissingWidth")
      : null;

    return {
      bytes: 1,
      widths: widths,
      /* The spec's default for a glyph the font does not list is zero, which
         would collapse the run it appears in. Half an em is nearer the truth
         for a character that is on the page at all. */
      missing: missing === null ? GLYPH_UNITS / 2 : missing,
      known: true
    };
  }

  /* /W comes in two shapes and a single file uses both: "c [w1 w2 …]" gives one
     width per glyph from c on, and "cFirst cLast w" gives one width to a whole
     run of glyphs. */
  function parseWidths(source, into) {
    var tokens = String(source || "").match(/\[|\]|-?[\d.]+/g) || [];
    var pending = [];
    var i = 0;

    while (i < tokens.length) {
      var token = tokens[i];
      i += 1;

      if (token === "]") { pending = []; continue; }

      if (token === "[") {
        var from = pending.length ? Number(pending[pending.length - 1]) : 0;
        var at = 0;
        while (i < tokens.length && tokens[i] !== "]") {
          into[from + at] = Number(tokens[i]);
          at += 1;
          i += 1;
        }
        i += 1;
        pending = [];
        continue;
      }

      pending.push(token);
      if (pending.length < 3) continue;

      var start = Number(pending[0]);
      var stop = Number(pending[1]);
      var width = Number(pending[2]);
      pending = [];
      if (!isFinite(start) || !isFinite(stop) || stop < start || stop - start > 65535) continue;
      for (var code = start; code <= stop; code += 1) into[code] = width;
    }
    return into;
  }

  /* The resource names a content stream uses — /F4 and the like — mean whatever
     the dictionary that owns that stream says they mean. So the lookup is built
     per stream: from the stream's own /Resources when it is a form, from the
     page that names it in /Contents otherwise, and from every /Font dictionary
     in the file as a last resort. */
  function fontTables(streams, index, pages) {
    var anywhere = {};
    Object.keys(index).forEach(function (key) {
      addFonts(dictionaryValue(index[key], "Font", index), index, anywhere);
    });

    return streams.map(function (stream) {
      var own = resourceFonts(stream.dict, index);
      if (own) return own;
      var page = pageFor(pages, stream.num);
      var fromPage = page ? resourceFonts(page, index) : null;
      return fromPage || anywhere;
    });
  }

  function resourceFonts(source, index) {
    var resources = dictionaryValue(source, "Resources", index);
    var fonts = dictionaryValue(resources || source, "Font", index);
    var table = {};
    return addFonts(fonts, index, table) ? table : null;
  }

  function addFonts(fonts, index, into) {
    if (!fonts) return false;
    var pairs = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g;
    var added = 0;
    var hit;

    while ((hit = pairs.exec(fonts))) {
      if (into[hit[1]] !== undefined) continue;
      var metrics = fontMetrics(index, parseInt(hit[2], 10), {});
      if (!metrics) continue;
      into[hit[1]] = metrics;
      added += 1;
    }
    return added > 0;
  }

  function pageObjects(index) {
    var out = [];
    Object.keys(index).forEach(function (key) {
      /* /Type /Pages is the tree above the pages and is not one of them. */
      if (/\/Type\s*\/Page(?![A-Za-z])/.test(index[key])) out.push(index[key]);
    });
    return out;
  }

  function pageFor(pages, num) {
    if (!(num > 0)) return null;
    var names = new RegExp("\\/Contents\\s*(?:\\[[^\\]]*)?\\b" + num + "\\s+\\d+\\s+R");
    for (var i = 0; i < pages.length; i += 1) {
      if (names.test(pages[i])) return pages[i];
    }
    return null;
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

  /* A hex string: <48656c6c6f>. Two digits per byte. */
  function hexCodes(source, from) {
    var digits = "";
    var i = from;
    while (i < source.length && source.charAt(i) !== ">") {
      var ch = source.charAt(i);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
      i += 1;
    }
    if (digits.length % 2) digits += "0";

    var codes = [];
    for (var j = 0; j < digits.length; j += 2) codes.push(parseInt(digits.substr(j, 2), 16));
    return { codes: codes, next: i + 1 };
  }

  /* The same string as letters. UTF-16BE when it opens with a byte order mark,
     which is how accented names usually arrive. */
  function readHex(source, from, cmap) {
    var read = hexCodes(source, from);
    return { text: decodeCodes(read.codes, cmap), next: read.next };
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
     position it was shown at and how wide it came out. Only the operators that
     move the pen, pick a font or print are understood; everything else is
     skipped, which is why a page of vector graphics costs nothing here. */
  function runsFrom(content, page, into, cmap, fonts) {
    var x = 0, y = 0;         /* the text line's origin */
    var cursor = 0;           /* where the pen stands along that line */
    var lead = 0;             /* leading, for T* */
    var pending = "";
    var pendingX = 0;
    var measured = true;
    var font = null;
    var size = 0;
    var scale = 1;            /* the horizontal part of the text matrix */
    var hscale = 1;           /* Tz, as a multiplier */
    var charSpacing = 0;      /* Tc */
    var wordSpacing = 0;      /* Tw */
    var name = "";
    var inText = false;       /* between BT and ET, which is the only place text is shown */
    var inArray = 0;
    var stack = [];
    var i = 0;

    function flush() {
      if (!pending) return;
      if (into.length < MAX_RUNS) {
        into.push({
          page: page,
          x: pendingX,
          y: y,
          text: pending,
          order: into.length,
          size: size > 0 ? size : 0,
          width: Math.max(0, cursor - pendingX),
          /* A run whose font had no widths, or whose widths added up to
             nothing, is one the cell splitter has to estimate instead. */
          measured: measured && cursor > pendingX
        });
      }
      pending = "";
      measured = true;
    }

    /* What this string advances the pen by, from the glyphs it actually holds.
       Null means the font kept its widths to itself. */
    function advanceOfCodes(codes) {
      if (!font || !font.known || !(size > 0)) return null;
      var total = 0;
      var step = font.bytes === 2 ? 2 : 1;
      var at;

      for (at = 0; at + step - 1 < codes.length; at += step) {
        var code = step === 2 ? ((codes[at] << 8) | codes[at + 1]) : codes[at];
        var width = font.widths[code];
        total += ((width === undefined ? font.missing : width) / GLYPH_UNITS) * size;
        total += charSpacing;
        /* Tw applies to the single byte 32 and to nothing else, so a two-byte
           font never takes it. */
        if (step === 1 && code === 32) total += wordSpacing;
      }
      return total * hscale * scale;
    }

    function show(codes, text) {
      if (!inText) return;
      if (!pending) pendingX = cursor;
      pending += text;
      var step = advanceOfCodes(codes);
      if (step === null) measured = false;
      else cursor += step;
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
        var codes = codesOf(literal.text);
        /* A literal in a subset font carries the same glyph codes a hex string
           would, so it takes the same road back to letters. */
        show(codes, cmap && cmap.size ? decodeCodes(codes, cmap) : literal.text);
        i = literal.next;
        continue;
      }

      /* A dictionary's angles, which a marked-content operator puts inside a
         text object. Reading one as a hex string would show its digits as
         glyphs and advance the pen for them. */
      if (ch === "<" && content.charAt(i + 1) === "<") { i += 2; continue; }
      if (ch === ">" && content.charAt(i + 1) === ">") { i += 2; continue; }

      if (ch === "<") {
        var hex = hexCodes(content, i + 1);
        show(hex.codes, decodeCodes(hex.codes, cmap));
        i = hex.next;
        continue;
      }

      if (ch === "/") {
        name = "";
        i += 1;
        while (i < content.length && /[^\s/<>[\]()%]/.test(content.charAt(i))) {
          name += content.charAt(i);
          i += 1;
        }
        continue;
      }

      if (ch === "[") { if (inText) inArray += 1; i += 1; continue; }
      if (ch === "]") { if (inArray > 0) inArray -= 1; i += 1; continue; }

      /* A number or a name: collect it as an operand. */
      if (/[-+.\d]/.test(ch)) {
        var num = "";
        while (i < content.length && /[-+.\d]/.test(content.charAt(i))) {
          num += content.charAt(i);
          i += 1;
        }
        /* Inside a TJ array a number is a kern: it moves the pen without
           printing anything, and in thousandths of the type size. */
        if (inText && inArray > 0 && size > 0) {
          var kern = Number(num);
          if (isFinite(kern)) cursor -= (kern / GLYPH_UNITS) * size * hscale * scale;
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

        if (op === "Tf") {
          size = numbers(1)[0];
          font = (fonts && name && fonts[name]) ? fonts[name] : null;
          stack = [];
          continue;
        }
        if (op === "Tc") { charSpacing = numbers(1)[0]; stack = []; continue; }
        if (op === "Tw") { wordSpacing = numbers(1)[0]; stack = []; continue; }
        if (op === "Tz") {
          var percent = numbers(1)[0];
          hscale = percent > 0 ? percent / 100 : 1;
          stack = [];
          continue;
        }
        if (op === "Td" || op === "TD") {
          flush();
          var td = numbers(2);
          x += td[0];
          y += td[1];
          cursor = x;
          if (op === "TD") lead = -td[1];
          stack = [];
          continue;
        }
        if (op === "Tm") {
          flush();
          var tm = numbers(6);
          x = tm[4];
          y = tm[5];
          cursor = x;
          scale = Math.abs(tm[0]) > 0 ? Math.abs(tm[0]) : 1;
          stack = [];
          continue;
        }
        if (op === "TL") { lead = numbers(1)[0]; stack = []; continue; }
        if (op === "T") { stack = []; continue; }
        if (op === "Tstar" || op === "T*") {
          flush();
          y -= lead;
          cursor = x;
          stack = [];
          continue;
        }
        if (op === "BT") {
          flush();
          inText = true;
          inArray = 0;
          x = 0; y = 0; cursor = 0;
          /* BT resets the text matrix to the identity, so a scale left over
             from the last text object must not be carried into this one. The
             character and word spacing belong to the graphics state instead and
             do survive, which is why they are not touched here. */
          scale = 1;
          stack = [];
          continue;
        }
        if (op === "ET") { flush(); inText = false; stack = []; continue; }
        if (op === "Tj" || op === "TJ") { flush(); stack = []; continue; }
        if (op === "'" || op === '"') { flush(); y -= lead; cursor = x; stack = []; continue; }

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

  /* ------------------------------------------------- dates and amounts --- */

  /* The date forms a Turkish bank prints, plus the ISO one a few of them use.
     The parts are checked rather than merely counted, so an instalment note's
     "1/12" and a card's own "19/9" are not read as dates. */
  var DATE_FORMS = [
    { re: /(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, year: 1, month: 2, day: 3 },
    { re: /(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g, day: 1, month: 3, year: 4 }
  ];

  /* Money, in every grouping a statement uses: 1.234,56 and 1,234.56 and
     1234,56 and 1234.56, signed or bracketed, with or without a currency after
     it. The two decimals are what tell an amount from a date.
     An ordinary space is not accepted between the thousands, only the
     non-breaking one a typesetter uses on purpose: a branch called "SUBE 12"
     sits right before the amount on a card statement, and reading the two
     together as "12 412.90" would turn a 412 lira coffee into twelve thousand. */
  var MONEY = new RegExp(
    "[-+(]?" +
    "(?:\\d{1,3}(?:[.,\\u00A0]\\d{3})+|\\d+)" +
    "[.,]\\d{2}(?!\\d)" +
    "\\)?" +
    "(?:\\s?(?:TL|TRY|USD|EUR|\\u20BA|\\u20AC|\\$))?" +
    "-?",
    "g"
  );

  function datesIn(text) {
    var body = String(text || "");
    var found = [];

    DATE_FORMS.forEach(function (form) {
      form.re.lastIndex = 0;
      var hit;
      while ((hit = form.re.exec(body))) {
        var day = Number(hit[form.day]);
        var month = Number(hit[form.month]);
        var year = Number(hit[form.year]);
        var plausible = day >= 1 && day <= 31 && month >= 1 && month <= 12
          && (hit[form.year].length === 2 ? year >= 0 : (year >= 1900 && year <= 2199));
        if (plausible) found.push({ at: hit.index, text: hit[0] });
      }
    });

    /* "2026-03-01" is also, read from its third character on, "26-03-01". The
       longer reading starts first, so sorting and then dropping anything that
       overlaps what is already kept leaves one date per date. */
    found.sort(function (a, b) {
      if (a.at !== b.at) return a.at - b.at;
      return b.text.length - a.text.length;
    });

    var out = [];
    var reach = -1;
    found.forEach(function (one) {
      if (one.at < reach) return;
      out.push(one);
      reach = one.at + one.text.length;
    });
    return out;
  }

  function amountsIn(text) {
    var body = String(text || "");

    /* A date reads as money if you let it: "01.09.2026" opens with "01.09".
       Blanking the dates first, in place so every offset still points where it
       did, is what keeps the two apart. */
    var masked = body;
    datesIn(body).forEach(function (date) {
      var blanks = "";
      while (blanks.length < date.text.length) blanks += " ";
      masked = masked.slice(0, date.at) + blanks + masked.slice(date.at + date.text.length);
    });

    var out = [];
    MONEY.lastIndex = 0;
    var hit;
    while ((hit = MONEY.exec(masked))) {
      if (!hit[0]) { MONEY.lastIndex += 1; continue; }
      out.push({ at: hit.index, text: hit[0] });
    }
    return out;
  }

  function startsWithDate(text) {
    var dates = datesIn(text);
    return dates.length > 0 && dates[0].at === 0;
  }

  /* Reads one line the way a person reads it: a line carrying a date and at
     least one amount after it is a transaction, whatever the page's grid says,
     and the description is what sits between the two. Everything else on a
     statement — rate tables, totals, addresses, the legal small print — carries
     one or the other but never both. */
  function transactionFrom(text) {
    var body = String(text || "");
    var dates = datesIn(body);
    if (!dates.length) return null;

    var date = dates[0];
    var from = date.at + date.text.length;
    var amounts = [];
    amountsIn(body).forEach(function (one) {
      if (one.at >= from) amounts.push(one);
    });
    if (!amounts.length) return null;

    var row = [date.text, tidy(body.slice(from, amounts[0].at))];
    amounts.forEach(function (one) { row.push(one.text.trim()); });
    return row;
  }

  function tidy(text) {
    return String(text || "").replace(/\s+/g, " ").replace(/^[\s|:;,.-]+|[\s|:;,.-]+$/g, "").trim();
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
      /* Which line a run came from decides the reading order inside a cell that
         was set over several of them. */
      run.line = lines.length - 1;
      current.runs.push(run);
    });

    return lines;
  }

  /* How wide a character is in this file, measured rather than assumed. A
     printer that emits one run per glyph gives the advance directly: the step
     from one run's origin to the next, over the characters in between. This is
     only the fallback now — a font that keeps its /Widths to itself — because
     one median figure for a whole page is exactly what merged a date, a payee
     and an amount into a single cell. */
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

  /* The pitch of this page's body lines, which is what tells a wrapped header
     cell — set closer to the line above it than a new line would be — from the
     next line of the table. */
  function pitchOf(lines) {
    var gaps = [];
    for (var i = 1; i < lines.length; i += 1) {
      if (lines[i].page !== lines[i - 1].page) continue;
      var gap = Math.abs(lines[i].y - lines[i - 1].y);
      /* A jump of a hundred units is a new block on the page, not a line, and a
         page whose footer sits in its own form has one of those in the middle
         of the list. */
      if (gap > 0.5 && gap < 100) gaps.push(gap);
    }
    if (!gaps.length) return 0;
    gaps.sort(function (a, b) { return a - b; });
    return gaps[Math.floor(gaps.length / 2)];
  }

  function sizeOf(line) {
    var size = 0;
    line.runs.forEach(function (run) {
      if (run.size > size) size = run.size;
    });
    return size > 0 ? size : CHAR_WIDTH * 2;
  }

  function wrapWindow(size, pitch) {
    var bySize = size * WRAP_SHARE;
    if (!(pitch > 0)) return bySize;
    return Math.min(bySize, pitch * WRAP_PITCH_SHARE);
  }

  /* Groups a page's lines into table rows. A header cell set over three lines
     is still one cell of one row, and reading it as three rows is what makes
     the rate table above the statement look like the statement's header. Two
     things keep a transaction out of this: a line that opens with a date always
     starts its own row, and a line carrying an amount is a row of its own too,
     because no wrapped header ever carries money. */
  function toRows(lines, advance) {
    var pitch = pitchOf(lines);
    var rows = [];
    var current = null;

    lines.forEach(function (line) {
      var size = sizeOf(line);
      var cells = cellsFrom(line.runs, advance);
      var text = textOf(cells);
      var dateLed = startsWithDate(cells.length ? cells[0].text : "");
      var money = amountsIn(text).length > 0;

      var joins = current
        && current.page === line.page
        && !current.dateLed && !current.money && !dateLed && !money
        && Math.abs(line.y - current.y) <= wrapWindow(Math.max(current.size, size), pitch);

      if (joins) {
        current.runs = current.runs.concat(line.runs);
        current.cells = cellsFrom(current.runs, advance);
        current.text = textOf(current.cells);
        current.y = line.y;
        current.size = Math.max(current.size, size);
        return;
      }

      current = {
        page: line.page,
        y: line.y,
        size: size,
        runs: line.runs.slice(),
        cells: cells,
        text: text,
        dateLed: dateLed,
        money: money
      };
      rows.push(current);
    });

    return rows;
  }

  function textOf(cells) {
    return cells.map(function (cell) { return cell.text; }).join(" ");
  }

  /* Words that belong to one kind of statement and not the other. An instalment
     and a minimum payment exist only on a card; a running balance and an IBAN
     only on an account. The page is read whole because these words sit in the
     masthead and the summary box, nowhere near the columns the importer sees. */
  var CARD_MARKS = ["taksit", "asgari odeme", "asgari ödeme", "kredi kart",
    "donem borcu", "dönem borcu", "hesap ozeti", "hesap özeti", "son odeme tarihi",
    "son ödeme tarihi", "kart no", "credit card", "minimum payment",
    "statement balance", "instalment", "installment"];
  var ACCOUNT_MARKS = ["iban", "bakiye", "hesap hareket", "vadesiz", "mevduat",
    "running balance", "account statement", "opening balance", "closing balance"];

  function countMarks(hay, marks) {
    var hits = 0;
    for (var i = 0; i < marks.length; i += 1) {
      if (hay.indexOf(marks[i]) !== -1) hits += 1;
    }
    return hits;
  }

  /* "card", "account", or null when the page does not say. Null is a real
     answer and the importer treats it as "work it out yourself": guessing here
     on one weak word would invert every row on the strength of a coincidence. */
  function documentKind(lines) {
    var hay = "";
    for (var i = 0; i < lines.length && hay.length < 4000; i += 1) {
      hay += " " + textOf(lines[i].cells || lines[i].runs || []);
    }
    hay = hay.toLowerCase();

    var card = countMarks(hay, CARD_MARKS);
    var account = countMarks(hay, ACCOUNT_MARKS);
    if (card > account && card >= 2) return "card";
    if (account > card && account >= 2) return "account";
    return null;
  }

  /* Splits a row into cells wherever the pen jumped further than a word space.
     This is what makes a PDF table a table: the columns are in the geometry,
     not in any delimiter. Where one cell ends and the next begins is a question
     about this document, not about PDF — a space between two words and the
     space between two columns are both just gaps — so both are read against the
     type size the bank actually used, which the font metrics give us. */
  function cellsFrom(runs, advance) {
    var estimate = advance > 0 ? advance : CHAR_WIDTH;
    var items = [];

    runs.forEach(function (run) {
      var text = String(run.text || "");
      if (!text.trim()) return;
      var size = run.size > 0 ? run.size : 0;
      items.push({
        text: text,
        x: run.x,
        end: run.x + (run.measured ? run.width : text.length * estimate),
        line: run.line || 0,
        space: size > 0 ? Math.max(1, size * SPACE_SHARE) : estimate * 0.52,
        column: size > 0 ? Math.max(CELL_GAP, size * COLUMN_SHARE) : Math.max(CELL_GAP, estimate * 2.6)
      });
    });

    items.sort(function (a, b) {
      if (a.x !== b.x) return a.x - b.x;
      return a.line - b.line;
    });

    var groups = [];
    var group = null;
    items.forEach(function (item) {
      if (group && item.x - group.end > group.column) group = null;
      if (!group) {
        group = { members: [], x: item.x, end: item.end, column: item.column };
        groups.push(group);
      }
      group.members.push(item);
      if (item.end > group.end) group.end = item.end;
      if (item.x < group.x) group.x = item.x;
      group.column = item.column;
    });

    var cells = [];
    groups.forEach(function (one) {
      /* Inside a cell the reading order is the order the lines were printed in,
         not the order of the x positions: "KALAN", "BORC(TL)" and "TAKSIT" are
         one heading set over three lines and belong together in that order. */
      var members = one.members.slice().sort(function (a, b) {
        if (a.line !== b.line) return a.line - b.line;
        return a.x - b.x;
      });

      var text = "";
      var previous = null;
      members.forEach(function (item) {
        if (text && (previous.line !== item.line || item.x - previous.end > item.space)) text += " ";
        text += item.text;
        previous = item;
      });

      text = text.trim();
      if (text) cells.push({ text: text, x: one.x, end: one.end });
    });
    return cells;
  }

  function cellsOf(line, advance) {
    return cellsFrom(line.runs, advance).map(function (cell) { return cell.text; });
  }

  /* --------------------------------------------------------- the passes --- */

  function looksLikeTransaction(cells) {
    return transactionFrom(cells.join(" ")) !== null;
  }

  function countTransactions(rows) {
    var total = 0;
    rows.forEach(function (cells) { if (looksLikeTransaction(cells)) total += 1; });
    return total;
  }

  /* The page's own grid, which is the right answer when the bank's columns line
     up — the header names the columns and the rows fall under it. */
  function tablePass(rows) {
    var table = rows.map(function (row) {
      return row.cells.map(function (cell) { return cell.text; });
    }).filter(function (cells) { return cells.length > 0; });

    var headerAt = findHeader(table);
    var headers = headerAt >= 0 ? table[headerAt] : [];
    var out = table.slice(headerAt + 1).filter(function (cells) { return cells.length > 1; });

    return { pass: "table", headers: headers, rows: out, usable: countTransactions(out) };
  }

  /* The same page with the grid ignored. Geometry fails somewhere, on some
     bank, and nobody is going to debug it, so this reading asks only what a
     person asks: is there a date on this line, and is there an amount. */
  function linePass(rows) {
    var out = [];
    rows.forEach(function (row) {
      var found = transactionFrom(row.text);
      if (found) out.push(found);
    });
    return { pass: "lines", headers: headerNames(commonWidth(out)), rows: out, usable: out.length };
  }

  function commonWidth(rows) {
    var counts = {};
    var best = 0;
    var width = 0;
    rows.forEach(function (row) {
      var at = row.length;
      counts[at] = (counts[at] || 0) + 1;
      if (counts[at] > best || (counts[at] === best && at > width)) {
        best = counts[at];
        width = at;
      }
    });
    return width;
  }

  /* The line reading finds no header on the page, so the columns are named
     after what they hold. The names come out of the catalogue, which means the
     importer recognises them in whichever language is loaded. */
  function headerNames(width) {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.t !== "function" || !(width > 0)) return [];
    var known = [I18n.t("csv.role.date"), I18n.t("csv.role.note"), I18n.t("csv.role.amount")];
    var out = [];
    for (var i = 0; i < width; i += 1) {
      out.push(i < known.length ? known[i] : I18n.t("csv.column", { index: i + 1 }));
    }
    return out;
  }

  /* A page with pictures on it and almost no text is a scan, or a statement
     re-rendered by a phone app: a picture of a table. No amount of geometry
     finds anything in one, so the reader says which file to fetch instead of
     presenting an empty table.
     Two things give it away, and either is enough. The page may hold less text
     than a statement's own heading would. Or the text it does hold may be
     buried under far more picture than any logo accounts for, which is what a
     flattened table looks like from the outside. */
  function scanVerdict(images, imageBytes, characters, pages) {
    if (!(images > 0)) return null;
    if (characters < SCAN_CHARS * Math.max(1, pages || 1)) return ERR.scanned;
    if (characters > 0 && imageBytes / characters > SCAN_WEIGHT) return ERR.scanned;
    return null;
  }

  /* -------------------------------------------------------------- read --- */

  /**
   * Reads a statement out of a PDF.
   * @returns {Promise<{headers: string[], rows: string[][], lines: number,
   *                    pages: number, pass: string, passKey: string,
   *                    skipped: number, warnings: string[]}>}
   */
  function read(file) {
    return bytesOf(file).then(function (bytes) {
      var head = latin1(bytes, 0, 1024);
      if (head.indexOf("%PDF") === -1) throw fail(ERR.notPdf);
      if (isEncrypted(bytes)) throw fail(ERR.encrypted);

      var streams = collectStreams(bytes);
      if (!streams.length) throw fail(ERR.noText);

      return decodeStreams(streams).then(function (texts) {
        var index = objectIndex(bytes);
        indexObjectStreams(streams, texts, index);

        var pageBodies = pageObjects(index);
        var fonts = fontTables(streams, index, pageBodies);

        /* The maps have to be in hand before a single run is read, and they
           arrive in their own streams anywhere in the file. */
        var cmap = { map: {}, width: 1, size: 0 };
        texts.forEach(function (content) {
          if (!content) return;
          if (content.indexOf("beginbfchar") === -1 && content.indexOf("beginbfrange") === -1) return;
          readCMap(content, cmap);
        });

        var runs = [];
        var drawn = 0;
        texts.forEach(function (content, at) {
          if (!content) return;
          if (content.indexOf("BT") === -1) return;
          if (content.indexOf("Tj") === -1 && content.indexOf("TJ") === -1) return;
          drawn += 1;
          runsFrom(content, at, runs, cmap, fonts[at]);
        });

        var images = 0;
        var imageBytes = 0;
        streams.forEach(function (stream) {
          if (!stream.image) return;
          images += 1;
          imageBytes += stream.bytes.length;
        });
        var characters = 0;
        runs.forEach(function (run) { characters += String(run.text || "").length; });
        var pages = pageBodies.length || drawn || 1;
        var verdict = scanVerdict(images, imageBytes, characters, pages);

        if (!runs.length) throw fail(verdict || ERR.noText);

        var lines = toLines(runs);
        var advance = advanceOf(lines);
        var rows = toRows(lines, advance);
        if (!rows.length) throw fail(ERR.noText);

        /* Both readings run, every time, and the one that found more
           transactions is the one the wizard is handed. Neither can throw on
           the other's kind of page, so there is nothing to choose in advance
           and nothing to ask the reader. */
        var byTable = tablePass(rows);
        var byLines = linePass(rows);
        var chosen = byLines.usable > byTable.usable ? byLines : byTable;

        /* The picture test is only allowed to refuse a page that neither
           reading could find a transaction on. A page that imports is never
           turned away for having a logo on it, however heavy the logo. */
        if (!chosen.usable && verdict) throw fail(verdict);

        var warnings = [];
        if (chosen.rows.length < 2) warnings.push("pdf.warn.fewRows");

        return {
          headers: chosen.headers,
          rows: normalise(chosen.rows, chosen.headers.length),
          lines: lines.length,
          pages: pages,
          pass: chosen.pass,
          passKey: chosen.pass === "lines" ? "pdf.read.lines" : "pdf.read.table",
          usable: chosen.usable,
          skipped: Math.max(0, lines.length - chosen.usable),
          /* Which kind of statement this is, read from the whole page rather
             than from the few words that survive into the headers. The importer
             needs it because a card lists what it spent as a positive figure
             while an account writes the same money with a minus, and only the
             page as a whole says which document is in hand. */
          documentKind: documentKind(lines),
          warnings: warnings
        };
      });
    });
  }

  /* The header is the line the table hangs under. Shape alone cannot find it on
     a page carrying more than one table — an interest-rate table with three
     columns above a four-column statement looks every bit as much like a header
     — so the transactions are found first and the header is the row above them.
     Returns -1 when the page opens straight into its transactions, so that
     none of them is eaten as a heading. */
  function findHeader(table) {
    var first = -1;
    var i;
    for (i = 0; i < table.length; i += 1) {
      if (looksLikeTransaction(table[i])) { first = i; break; }
    }

    if (first > 0) {
      for (i = first - 1; i >= 0; i -= 1) {
        if (table[i].length >= 2 && !looksLikeTransaction(table[i])) return i;
      }
    }
    if (first !== -1) return -1;
    return findByShape(table);
  }

  /* With no transaction anywhere in the table the only thing left to go on is
     shape: the header is the first line whose shape the lines under it repeat,
     the same rule CSV.sniff uses and for the same reason. */
  function findByShape(table) {
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

    /* Both shapes of /W in one array, which is how a real file writes it: a
       list from one code on, and one width over a run of codes. */
    var cid = { 11: "<</Type/Font/Subtype/Type0/DescendantFonts[12 0 R]>>",
      12: "<</Subtype/CIDFontType2/W[3[500 600]8 10 250 20[750]]/DW 400>>" };
    var wide = fontMetrics(cid, 11, {});
    check("W list form", wide && [wide.widths[3], wide.widths[4]], [500, 600]);
    check("W range form", wide && [wide.widths[8], wide.widths[9], wide.widths[10]], [250, 250, 250]);
    check("W after a range", wide && wide.widths[20], 750);
    check("DW is the default", wide && wide.missing, 400);
    check("a CID font takes two bytes a glyph", wide && wide.bytes, 2);

    var simple = { 5: "<</Type/Font/Subtype/TrueType/FirstChar 65/Widths[700 800 900]>>" };
    var plain = fontMetrics(simple, 5, {});
    check("Widths from FirstChar", plain && [plain.widths[65], plain.widths[67]], [700, 900]);
    check("a simple font takes one byte a glyph", plain && plain.bytes, 1);
    check("a font with no widths is not measured", fontMetrics({ 6: "<</Type/Font/Subtype/Type1>>" }, 6, {}), null);

    /* A run's end measured from the glyphs it holds, not from a median. Four
       digits of a 500/1000 em font at 10pt are 20 wide, so the run that starts
       at 100 ends at 120 and the gap to 130 is a word space rather than the
       nothing a per-character guess of 7.5 would have left. */
    var measuredRuns = [];
    runsFrom("BT /F1 10 Tf 100 700 Td <0003000300030003> Tj 130 700 Td <0003> Tj ET",
      0, measuredRuns, null, { F1: { bytes: 2, widths: { 3: 500 }, missing: 500, known: true } });
    check("a run is measured, not guessed", measuredRuns[0] && Math.round(measuredRuns[0].width), 20);
    check("a measured run says so", measuredRuns[0] && measuredRuns[0].measured, true);

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

    /* A header cell set over three lines is one row, and the row below it opens
       with a date and so is never pulled into it. */
    var wrapped = toRows(toLines([
      { page: 0, x: 24, y: 210, text: "ISLEM", size: 12, width: 33, measured: true },
      { page: 0, x: 159, y: 210, text: "ACIKLAMA", size: 12, width: 62, measured: true },
      { page: 0, x: 420, y: 210, text: "TUTAR", size: 12, width: 39, measured: true },
      { page: 0, x: 24, y: 224, text: "TARIHI", size: 12, width: 40, measured: true },
      { page: 0, x: 438, y: 224, text: "(TL)", size: 12, width: 23, measured: true },
      { page: 0, x: 24, y: 252, text: "14/02/2026", size: 12, width: 60, measured: true },
      { page: 0, x: 159, y: 252, text: "AYDEDE MARKET", size: 12, width: 95, measured: true },
      { page: 0, x: 423, y: 252, text: "412.90", size: 12, width: 36, measured: true },
      { page: 0, x: 24, y: 269, text: "15/02/2026", size: 12, width: 60, measured: true },
      { page: 0, x: 159, y: 269, text: "GUNESLI KAHVE", size: 12, width: 92, measured: true },
      { page: 0, x: 430, y: 269, text: "86.50", size: 12, width: 29, measured: true }
    ]), 6);
    check("a wrapped header is one row", wrapped.length, 3);
    check("the wrapped cells read in printing order",
      wrapped[0] && wrapped[0].cells.map(function (cell) { return cell.text; }),
      ["ISLEM TARIHI", "ACIKLAMA", "TUTAR (TL)"]);
    check("two dated lines never merge",
      [wrapped[1] && wrapped[1].cells.length, wrapped[2] && wrapped[2].cells.length], [3, 3]);

    check("header found under a preamble", findHeader([
      ["MEGA BANK"],
      ["Hesap: 4471"],
      ["Tarih", "Aciklama", "Tutar"],
      ["01.09.2026", "MAAS", "38.500,00"],
      ["02.09.2026", "KIRA", "-14.000,00"],
      ["03.09.2026", "MARKET", "-1.847,60"]
    ]), 2);

    /* The rate table above the statement has the same shape as a header and
       repeats it three times, which is why shape alone picked it. */
    check("the header is the line above the transactions, not the first table", findHeader([
      ["FAIZ ORANLARI", "AYLIK", "YILLIK"],
      ["Alisveris Faizi", "% 3.11", "% 37.32"],
      ["Nakit Avans Faizi", "% 4.11", "% 49.32"],
      ["Gecikme Faizi", "% 3.41", "% 40.92"],
      ["ISLEM TARIHI", "ACIKLAMA", "TUTAR (TL)"],
      ["14/02/2026", "AYDEDE MARKET", "412.90"],
      ["15/02/2026", "GUNESLI KAHVE", "86.50"]
    ]), 4);
    check("a table with no heading keeps all its rows", findHeader([
      ["14/02/2026", "AYDEDE MARKET", "412.90"],
      ["15/02/2026", "GUNESLI KAHVE", "86.50"]
    ]), -1);

    check("a date is read in every form a bank prints", [
      startsWithDate("13/03/2026 X"), startsWithDate("13.03.2026 X"),
      startsWithDate("13-03-2026 X"), startsWithDate("2026-03-13 X"),
      startsWithDate("13/03/26 X"), startsWithDate("1/12 taksit")
    ], [true, true, true, true, true, false]);
    check("an impossible date is not one", startsWithDate("32/13/2026"), false);

    check("money is read in every grouping", amountsIn("1.234,56 1,234.56 1234,56 1234.56")
      .map(function (one) { return one.text; }), ["1.234,56", "1,234.56", "1234,56", "1234.56"]);
    check("a signed amount keeps its sign", amountsIn("-3500.00 TL")
      .map(function (one) { return one.text; }), ["-3500.00 TL"]);
    check("a date is not an amount", amountsIn("01.09.2026 - 30.09.2026").length, 0);
    check("a branch number is not part of the amount after it",
      amountsIn("AYDEDE MARKET SUBE 12 412.90").map(function (one) { return one.text; }), ["412.90"]);

    /* The line reading has to find this one with a rate table sitting above it
       on the page and a legal footer below. */
    check("a line with a date and an amount is a transaction",
      transactionFrom("13/03/2026 AYDEDE MARKET SUBE 12 412.90 0.00"),
      ["13/03/2026", "AYDEDE MARKET SUBE 12", "412.90", "0.00"]);
    check("a rate table row is not a transaction", transactionFrom("Alisveris Faizi % 3.11 % 37.32"), null);
    check("a totals line is not a transaction", transactionFrom("DONEM BORCU 4771.65"), null);
    check("a line of dates alone is not a transaction",
      transactionFrom("Hesap Kesim Tarihi: 12/03/2026 - Son Odeme Tarihi: 27/03/2026"), null);
    check("a cell that failed to split still reads",
      transactionFrom("13/03/2026SIGORTA ORNEK SUBESI322.77 0.00"),
      ["13/03/2026", "SIGORTA ORNEK SUBESI", "322.77", "0.00"]);

    /* The failure the owner actually hit: a line whose columns ran together is
       one cell, the grid reading throws it away for having nothing to split,
       and the line reading finds all three transactions anyway. */
    var collapsed = toRows(toLines([
      { page: 0, x: 24, y: 100, text: "14/02/2026AYDEDE MARKET412.90", size: 12, width: 200, measured: true },
      { page: 0, x: 24, y: 120, text: "15/02/2026GUNESLI KAHVE86.50", size: 12, width: 200, measured: true },
      { page: 0, x: 24, y: 140, text: "16/02/2026BULUT AKARYAKIT1250.00", size: 12, width: 200, measured: true }
    ]), 6);
    check("a page whose columns ran together loses to the line reading",
      [tablePass(collapsed).usable, linePass(collapsed).usable], [0, 3]);

    /* And neither reading may fall over on the other's kind of page. */
    var wordy = toRows(toLines([
      { page: 0, x: 24, y: 100, text: "ORNEK KREDI BANKASI", size: 12, width: 120, measured: true },
      { page: 0, x: 24, y: 140, text: "Kredi Karti Hesap Ozeti", size: 12, width: 140, measured: true }
    ]), 6);
    check("a page with no transaction on it reads as none",
      [tablePass(wordy).usable, linePass(wordy).usable, linePass(wordy).headers.length], [0, 0, 0]);

    check("a page of pictures with no text is a scan", scanVerdict(2, 350000, 60, 1), "pdf.err.scanned");
    check("a page of pictures with a heading and nothing else is a scan",
      scanVerdict(2, 350000, 349, 1), "pdf.err.scanned");
    check("a page of text with a logo on it is not", scanVerdict(3, 24000, 842, 1), null);
    check("a page of text is not, however much there is", scanVerdict(2, 350000, 40000, 1), null);
    check("a page with no pictures is never a scan", scanVerdict(0, 0, 10, 1), null);

    check("short rows are padded", normalise([["a", "b"]], 3), [["a", "b", ""]]);

    return { ok: !failures.length, checks: checks, failures: failures };
  }

  Moon.PDF = {
    read: read,
    MAX_BYTES: MAX_BYTES,
    /* Exposed for the wizard's own messages and for the tests. */
    _runsFrom: runsFrom,
    _toLines: toLines,
    _toRows: toRows,
    _cellsOf: cellsOf,
    _cellsFrom: cellsFrom,
    _tablePass: tablePass,
    _linePass: linePass,
    _findHeader: findHeader,
    _fontMetrics: fontMetrics,
    _parseWidths: parseWidths,
    _datesIn: datesIn,
    _amountsIn: amountsIn,
    _transactionFrom: transactionFrom,
    _scanVerdict: scanVerdict,
    _selftest: selftest
  };
})(window);
