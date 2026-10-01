/* Moon — charts.
 *
 * Hand-written SVG strings; Moon.dom.svg() turns them into live nodes. No
 * library, no smoothing, no tooltips. Every stroke carries
 * vector-effect="non-scaling-stroke" so a 1px rule is still 1px after the
 * viewBox scales, and axes/ticks/cells ask for shape-rendering="crispEdges"
 * so they land on whole pixels instead of blurring across two.
 *
 * This file never translates and never formats money on its own account.
 * Titles, descriptions, series names and sentences arrive through opts as
 * FINISHED strings (the caller ran them through Moon.I18n.t); numbers pass
 * through opts.formatValue / opts.formatDate. The fallbacks below are bare
 * numerals, never words, so a missing formatter degrades instead of shipping
 * an untranslated sentence.
 *
 * Colour is only ever a CSS variable: --dial money leaving, --gauge money
 * arriving, --accent a portfolio's own value, --ink-dim ghosts and labels,
 * --over (or --flare) an overrun, --rule ticks and baselines. The moon disc
 * paints in currentColor instead, so the card it sits on decides its colour in
 * CSS. No raw hex lives in this file. A record's own colour is the one
 * exception, and it is not written as a colour either: it arrives as an inline
 * --tone on the element that needs it and every paint reads var(--tone), which
 * is the contract the stylesheet was written against (spec §10).
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var NS = 'xmlns="http://www.w3.org/2000/svg"';
  var VE = ' vector-effect="non-scaling-stroke"';
  var CRISP = ' shape-rendering="crispEdges"';

  /* Three stroke widths exist in this application and no others. */
  var W_REF = 1;      /* reference lines, ghosts, ticks */
  var W_SERIES = 1.5; /* a data series */
  var W_MARK = 2;     /* the one emphasised mark per chart */

  var FILL_OPACITY = 0.12; /* flat area fill; never a gradient */

  /* The limit meter, redrawn. It used to be a vernier — a hairline track, nine
     ruler ticks and a 9px end cap — and inside a card on a phone it read as a
     measuring instrument somebody had left there. A reader asking "how much of
     the grocery money is gone" wants what a battery gauge shows, so the meter
     is now one thick rounded bar 24 units tall instead of 44.
     Three of these numbers are load-bearing OUTSIDE this file: js/views.limits.js
     lays a draggable grip over the limit cap and converts pixels back to money
     against this same viewBox, so the track's left edge (labelWidth + 4), the
     unit of track (trackWidth, renormalised above RENORM_AT) and the total
     width (labelWidth + trackWidth + readoutWidth + 8) must keep agreeing with
     trackUnit() / amountAt() / percentFor() there to the pixel. */
  var METER_H = 24;
  var BAR_H = 12;
  var RENORM_AT = 1.5;

  /* The share bar. .kindbar is drawn here and nowhere else: moon.css still
     carries a flex rule set written for an HTML version of the same component,
     and two implementations of one class cannot both be right. This one wins
     because stackedBar returns an SVG string like every other chart in the
     file, so every number the bar and its legend are measured in is declared
     below and none of them is left for a stylesheet to decide. KEY_SIZE is
     written as an inline style on the legend group for that reason — the
     leftover .kindbar__key rule sets a different size, and an estimate that
     disagrees with the rendered type is how a legend ends up on top of
     itself. */
  var SEG_H = 14;
  var SEG_GAP = 2;
  var SEG_MIN = 8; /* a holding worth 1% of the portfolio is still a holding */
  var KEY_SIZE = 12;   /* the legend's type size, in SVG units */
  var KEY_LINE = 17;   /* one legend line: KEY_SIZE and its leading */
  var KEY_CHAR = 7.2;  /* widest plausible glyph at KEY_SIZE — a tabular digit */
  var KEY_IN = 13;     /* the dot, and the gap between it and the name */
  var KEY_OUT = 13;    /* the gap after an entry, before the next dot */

  var FALLBACK_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  var seq = 0;

  /* ------------------------------------------------------------- helpers */

  /* Ids must be unique per document: patterns and clip paths are referenced
     by url(#id), and two charts on one page would otherwise share a mask. */
  function uid() {
    seq += 1;
    return "mc" + seq.toString(36);
  }

  function esc(value) {
    if (Moon.util && typeof Moon.util.esc === "function") return Moon.util.esc(value);
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"']/g, function (ch) {
      return FALLBACK_ESC[ch];
    });
  }

  function warn(what, error) {
    if (global.console && global.console.error) global.console.error("Moon.Charts " + what, error);
  }

  function pos(value, fallback) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function fin(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (isFinite(fallback) ? fallback : 0);
  }

  /* Every number that reaches the markup passes through here: one decimal is
     enough for a 620px viewBox, and NaN becomes 0 instead of "MNaN,NaN". */
  function r1(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
  }

  function list(value) {
    return Object.prototype.toString.call(value) === "[object Array]" ? value : [];
  }

  function clip(value, maxChars) {
    var s = value === null || value === undefined ? "" : String(value);
    if (maxChars > 0 && s.length > maxChars) {
      return s.slice(0, Math.max(1, maxChars - 1)) + "…";
    }
    return s;
  }

  /* Bare numerals, no separators, no currency: a locale-free last resort.
     Real screens pass opts.formatValue from Moon.Money. */
  function valueFormatter(opts) {
    if (opts && typeof opts.formatValue === "function") {
      return function (minor) {
        try {
          return String(opts.formatValue(minor));
        } catch (e) {
          warn("formatValue", e);
          return String(Math.round(fin(minor, 0) / 100));
        }
      };
    }
    return function (minor) {
      return String(Math.round(fin(minor, 0) / 100));
    };
  }

  /* "2026-09-26" -> "26". Day of month is a numeral, so it needs no catalogue. */
  function dateFormatter(opts) {
    if (opts && typeof opts.formatDate === "function") {
      return function (date) {
        try {
          return String(opts.formatDate(date));
        } catch (e) {
          warn("formatDate", e);
          return String(date || "");
        }
      };
    }
    return function (date) {
      var s = String(date || "");
      return s.length === 10 ? s.slice(8) : s;
    };
  }

  function svgOpen(spec) {
    var out = "<svg " + NS + ' viewBox="0 0 ' + r1(spec.w) + " " + r1(spec.h) + '"';
    out += ' width="100%" preserveAspectRatio="xMidYMid meet"';
    /* Charts fill their column; a fixed-size mark (the disc) also declares a
       ceiling, or width:100% would blow a 28px reading up to the full row. */
    out += ' style="width:100%;' + (spec.maxW ? "max-width:" + r1(spec.maxW) + "px;" : "") +
      'height:auto;display:block"';
    out += ' class="' + (spec.cls || "chart") + '"';
    out += ' role="' + (spec.role || "img") + '"';
    if (spec.ariaLabel) out += ' aria-label="' + esc(spec.ariaLabel) + '"';
    else out += ' aria-labelledby="t' + spec.id + " d" + spec.id + '"';
    if (spec.extra) out += spec.extra;
    out += ">";
    out += '<title id="t' + spec.id + '">' + esc(spec.title) + "</title>";
    out += '<desc id="d' + spec.id + '">' + esc(spec.desc) + "</desc>";
    return out;
  }

  function lineTag(x1, y1, x2, y2, stroke, width, attrs) {
    return '<line x1="' + r1(x1) + '" y1="' + r1(y1) + '" x2="' + r1(x2) + '" y2="' + r1(y2) +
      '" stroke="' + stroke + '" stroke-width="' + width + '"' + VE + (attrs || "") + "/>";
  }

  function rule(x1, y1, x2, y2, stroke, width, attrs) {
    return lineTag(x1, y1, x2, y2, stroke, width || W_REF, CRISP + (attrs || ""));
  }

  function rect(x, y, w, h, fill, attrs) {
    return '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(Math.max(0, w)) +
      '" height="' + r1(Math.max(0, h)) + '" fill="' + fill + '"' + (attrs || "") + "/>";
  }

  /* A rounded rect. The renderer clamps rx to half the width on its own, so a
     3-unit sliver comes out as a small pill instead of a clipped square and
     the caller never has to special-case a nearly empty bar. */
  function pill(x, y, w, h, radius, fill, attrs) {
    return '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(Math.max(0, w)) +
      '" height="' + r1(Math.max(0, h)) + '" rx="' + r1(radius) + '" fill="' + fill + '"' +
      (attrs || "") + "/>";
  }

  /* Spec §10: a record's colour reaches the page as an inline --tone and every
     paint reads var(--tone). That is also how this file keeps its promise never
     to write a literal colour — the hex belongs to the record, not to the
     chart. A value that is not plainly a colour is dropped rather than pasted
     into a style attribute, because this one arrives from stored data. */
  var TONE_OK = /^(#[0-9A-Fa-f]{3,8}|var\(--[A-Za-z0-9-]+\))$/;

  function toneStyle(value) {
    var s = value === null || value === undefined ? "" : String(value);
    if (!TONE_OK.test(s)) return "";
    return ' style="--tone:' + s + '"';
  }

  /* What a record with no colour of its own is painted in: the spectrum, by
     position, so a breakdown of seven kinds is still seven colours. It cannot
     be written as a var(--tone, …) fallback — moon.css declares --tone on
     :root, so the property is always defined and a fallback after it would
     never be reached. */
  function spectrumVar(index) {
    var i = Math.round(fin(index, 0));
    if (i < 0) i = 0;
    return "var(--cat-" + ((i % 10) + 1) + ")";
  }

  function pathTag(d, stroke, width, attrs) {
    return '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="' + width +
      '" stroke-linejoin="miter" stroke-linecap="butt"' + VE + (attrs || "") + "/>";
  }

  /* Only M and L. A bezier would invent readings between two measurements;
     the promise of this chart language is that it never prettifies data. */
  function poly(xs, ys) {
    var d = "";
    var i;
    for (i = 0; i < xs.length; i += 1) {
      d += (i === 0 ? "M" : "L") + r1(xs[i]) + " " + r1(ys[i]);
      if (i < xs.length - 1) d += " ";
    }
    return d;
  }

  /* A size of null writes no font-size at all, so the text takes the one its
     group declares. The legend uses that: one declaration for a dozen entries
     reads better than the same number repeated on every line, and it is the
     declaration the wrap estimate is computed from. */
  function label(x, y, value, fill, anchor, size) {
    if (value === null || value === undefined || value === "") return "";
    return '<text x="' + r1(x) + '" y="' + r1(y) + '"' +
      (size === null ? "" : ' font-size="' + (size || 11) + '"') +
      ' fill="' + (fill || "var(--ink-dim)") + '"' +
      (anchor ? ' text-anchor="' + anchor + '"' : "") +
      ' class="ch-label">' + esc(value) + "</text>";
  }

  /* Series names sit at the end of their own line, so two close series would
     print on top of each other. Push them apart instead of boxing a legend. */
  function stackLabels(items, top, bottom, gap) {
    var kept = [];
    var i;
    for (i = 0; i < items.length; i += 1) {
      if (items[i] && items[i].text) kept.push(items[i]);
    }
    kept.sort(function (a, b) {
      return a.y - b.y;
    });
    var space = gap || 12;
    for (i = 0; i < kept.length; i += 1) {
      if (i > 0 && kept[i].y - kept[i - 1].y < space) kept[i].y = kept[i - 1].y + space;
      if (kept[i].y > bottom) kept[i].y = bottom;
      if (kept[i].y < top) kept[i].y = top;
    }
    var out = "";
    for (i = 0; i < kept.length; i += 1) {
      out += label(kept[i].x, kept[i].y, kept[i].text, kept[i].fill, kept[i].anchor || "start");
    }
    return out;
  }

  /* One frame for the three time-series charts: a left gutter for the three y
     readings, a bottom band for first/middle/last date, a right gutter for
     series names. opts.compact drops all three (the 620x48 hero trace). */
  function frame(opts, def) {
    var w = pos(opts.width, def.w);
    var h = pos(opts.height, def.h);
    var compact = opts.compact === true;
    var pad = compact
      ? { t: 4, r: 4, b: 4, l: 4 }
      : { t: def.t, r: def.r, b: def.b, l: def.l };

    /* A narrow caller (320px phone strip) would otherwise be all gutter. */
    if (pad.l + pad.r > w * 0.6) {
      pad.l = Math.round(w * 0.08);
      pad.r = Math.round(w * 0.16);
    }
    if (pad.t + pad.b > h * 0.6) {
      pad.t = 4;
      pad.b = Math.round(h * 0.2);
    }

    return {
      w: w,
      h: h,
      pad: pad,
      x0: pad.l,
      y0: pad.t,
      iw: Math.max(8, w - pad.l - pad.r),
      ih: Math.max(8, h - pad.t - pad.b),
      labels: !compact
    };
  }

  /* Never divide by zero: a flat series gets an artificial range so the line
     lands in the middle of the plot instead of on a NaN. */
  function domain(values, extras) {
    var all = [];
    var i;
    for (i = 0; i < values.length; i += 1) {
      if (isFinite(values[i])) all.push(Number(values[i]));
    }
    var ex = list(extras);
    for (i = 0; i < ex.length; i += 1) {
      if (isFinite(ex[i])) all.push(Number(ex[i]));
    }
    if (!all.length) return { lo: 0, hi: 1 };

    var lo = all[0];
    var hi = all[0];
    for (i = 1; i < all.length; i += 1) {
      if (all[i] < lo) lo = all[i];
      if (all[i] > hi) hi = all[i];
    }
    if (hi === lo) {
      var grow = Math.max(1, Math.abs(hi) * 0.1);
      lo -= grow;
      hi += grow;
    }
    return { lo: lo, hi: hi };
  }

  function scaler(dom, y0, ih) {
    var span = dom.hi - dom.lo;
    return function (value) {
      var v = fin(value, dom.lo);
      return y0 + ih - ((v - dom.lo) / span) * ih;
    };
  }

  function yReadings(f, dom, fmt) {
    if (!f.labels) return "";
    var y = scaler(dom, f.y0, f.ih);
    var mid = (dom.lo + dom.hi) / 2;
    var x = f.x0 - 6;
    return label(x, y(dom.hi) + 8, fmt(dom.hi), "var(--ink-dim)", "end") +
      label(x, y(mid) + 4, fmt(mid), "var(--ink-dim)", "end") +
      label(x, y(dom.lo), fmt(dom.lo), "var(--ink-dim)", "end");
  }

  /* First, middle, last. No grid, no interior ticks. */
  function xReadings(f, dates, fmtDate) {
    if (!f.labels || !dates.length) return "";
    var y = f.y0 + f.ih + 13;
    var out = label(f.x0, y, fmtDate(dates[0]), "var(--ink-dim)", "start");
    if (dates.length > 2) {
      var mid = Math.floor(dates.length / 2);
      out += label(f.x0 + f.iw / 2, y, fmtDate(dates[mid]), "var(--ink-dim)", "middle");
    }
    if (dates.length > 1) {
      out += label(f.x0 + f.iw, y, fmtDate(dates[dates.length - 1]), "var(--ink-dim)", "end");
    }
    return out;
  }

  function empty(opts, defW, defH) {
    opts = opts || {};
    var w = pos(opts.width, defW);
    var h = pos(opts.height, defH);
    var id = uid();
    var message = opts.emptyText || opts.title || "";
    var out = svgOpen({
      w: w, h: h, id: id, cls: "chart chart--empty",
      title: opts.title || message,
      desc: opts.desc || message
    });
    /* An empty instrument still shows its baseline: the shape of the thing
       arrives before the data does. */
    out += rule(8, h - 12, w - 8, h - 12, "var(--rule)", W_REF);
    out += label(8, h / 2, clip(message, 72), "var(--ink-dim)", "start", 13);
    return out + "</svg>";
  }

  /* -------------------------------------------- keyboard readout plumbing */

  /* The chart is ONE focusable element, not a hundred focus stops. Arrow keys
     move an index, the caller is told through opts.onReadout(index) and prints
     the reading in its own single line of text. No tooltip ever appears. */
  var navs = Object.create(null);
  var navIds = [];
  var navListening = false;
  var NAV_LIMIT = 24;

  function remember(id, spec) {
    navs[id] = spec;
    navIds.push(id);
    while (navIds.length > NAV_LIMIT) {
      delete navs[navIds.shift()];
    }
    ensureNavListener();
  }

  function ensureNavListener() {
    if (navListening) return;
    var doc = global.document;
    if (!doc || typeof doc.addEventListener !== "function") return; /* node, or no DOM yet */
    doc.addEventListener("keydown", onNavKey, true);
    doc.addEventListener("focusin", onNavFocus, true);
    navListening = true;
  }

  function chartOf(node) {
    while (node && typeof node.getAttribute === "function") {
      var id = node.getAttribute("data-moon-chart");
      if (id) return { node: node, spec: navs[id] };
      node = node.parentNode;
    }
    return null;
  }

  function setIndex(node, spec, index, notify) {
    if (!spec || !spec.xs || !spec.xs.length) return;
    var i = Math.max(0, Math.min(spec.xs.length - 1, index));
    node.setAttribute("data-index", String(i));

    var x = String(r1(spec.xs[i]));
    var cursor = node.querySelector ? node.querySelector('[data-role="cursor"]') : null;
    if (cursor) {
      cursor.setAttribute("x1", x);
      cursor.setAttribute("x2", x);
      cursor.setAttribute("opacity", "1");
    }
    var dot = node.querySelector ? node.querySelector('[data-role="cursor-dot"]') : null;
    if (dot && spec.ys && isFinite(spec.ys[i])) {
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", String(r1(spec.ys[i])));
      dot.setAttribute("opacity", "1");
    }
    if (notify && typeof spec.onReadout === "function") {
      try {
        spec.onReadout(i);
      } catch (e) {
        warn("onReadout", e);
      }
    }
  }

  function onNavKey(event) {
    if (!event || event.altKey || event.ctrlKey || event.metaKey) return;
    var hit = chartOf(event.target);
    if (!hit || !hit.spec) return;

    var current = parseInt(hit.node.getAttribute("data-index"), 10);
    if (!isFinite(current) || current < 0) current = hit.spec.xs.length - 1;
    var next = null;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp": next = current + 1; break;
      case "ArrowLeft":
      case "ArrowDown": next = current - 1; break;
      case "Home": next = 0; break;
      case "End": next = hit.spec.xs.length - 1; break;
      case "PageUp": next = current + 7; break;
      case "PageDown": next = current - 7; break;
      default: return;
    }
    event.preventDefault();
    setIndex(hit.node, hit.spec, next, true);
  }

  function onNavFocus(event) {
    var hit = chartOf(event && event.target);
    if (!hit || !hit.spec || hit.node !== event.target) return;
    var current = parseInt(hit.node.getAttribute("data-index"), 10);
    setIndex(hit.node, hit.spec, isFinite(current) && current >= 0 ? current : hit.spec.xs.length - 1, true);
  }

  function navAttrs(id, count) {
    return ' tabindex="0" data-moon-chart="' + id + '" data-points="' + count + '" data-index="-1"';
  }

  function cursorTags(f) {
    return lineTag(f.x0, f.y0, f.x0, f.y0 + f.ih, "var(--ink-dim)", W_REF,
      CRISP + ' opacity="0" data-role="cursor"') +
      '<circle cx="' + r1(f.x0) + '" cy="' + r1(f.y0) + '" r="2.5" fill="var(--dial)" opacity="0" data-role="cursor-dot"/>';
  }

  /* ------------------------------------------------------------- the disc */

  /* A10: this is NOT a growing pie slice and not a moon phase. The circle is
     fixed; the measurement is WHERE the vertical boundary sits on the
     diameter (x = cx - r + 2r*ratio). Left of it is lit, right is empty.
     Every paint here is currentColor, because this is the one mark the
     application prints twice with two meanings and the caller is the only one
     who knows which: on the net-worth card it is Moon's own badge and
     .networth__phase hands it --accent, while in the hero pill it is a date
     ornament and the .disc class this file emits holds it at --ink-dim. Both
     arrive by inheritance, so a caller colours the disc in CSS and this
     function stays out of it. The lit side is solid rather than the 35% wash
     it used to be: a brand mark that clears 3:1 (§2.2) has to be the colour it
     claims to be, not a tint of it. */
  function discMarkup(cx, cy, r, ratio) {
    var id = uid();
    var t = Math.max(0, Math.min(1, fin(ratio, 0)));
    var edge = cx - r + 2 * r * t;
    /* A clip path uses geometry only, so the mask rect needs no real fill. */
    var out = '<defs><clipPath id="clip' + id + '">';
    out += rect(cx - r, cy - r, edge - (cx - r), 2 * r, "none");
    out += "</clipPath></defs>";
    out += '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(r) +
      '" fill="currentColor" clip-path="url(#clip' + id + ')"/>';
    /* The unlit side keeps nothing but an outline, and the outline is the same
       ink at a third of its weight: the rim used to borrow --rule, which is the
       stylesheet's border colour and belongs to the card, not to the moon. */
    out += '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(r) +
      '" fill="none" stroke="currentColor" stroke-opacity="0.4" stroke-width="' + W_REF + '"' + VE + "/>";
    /* The boundary is the reading, so it is the one crisp line here. */
    out += rule(edge, cy - r, edge, cy + r, "currentColor", W_REF);
    return out;
  }

  function hatchPattern(id, color) {
    /* 45 degrees, 3px apart. Laid over the solid overrun in the card's own
       ground colour it reads as stripes: the second channel of an overrun,
       readable in black and white and immune to colour blindness. */
    return '<pattern id="hatch' + id + '" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      lineTag(0, 0, 0, 3, color, W_REF) +
      "</pattern>";
  }

  /* ============================================================== charts */

  var Charts = {};

  /* Q: is the daily allowance holding, or is it melting?
     A step line, because an allowance stands for a whole day — interpolating
     between two days would draw amounts the budget never had. One reference:
     the allowance the period opened with. Above it you are ahead; below it the
     pool is shrinking and the chart shows which day did it. */
  Charts.allowanceTrail = function (trail, opts) {
    opts = opts || {};
    var raw = list(trail);
    var points = [];
    var i;
    for (i = 0; i < raw.length; i += 1) {
      if (raw[i] && isFinite(Number(raw[i].perDay))) points.push(raw[i]);
    }
    if (!points.length) return empty(opts, 620, 96);

    var fmt = valueFormatter(opts);
    var fmtDate = dateFormatter(opts);
    var f = frame(opts, { w: 620, h: 96, t: 10, r: 76, b: 18, l: 56 });
    var id = uid();

    var values = [];
    var dates = [];
    for (i = 0; i < points.length; i += 1) {
      values.push(Number(points[i].perDay));
      dates.push(points[i].date);
    }

    var reference = null;
    if (isFinite(Number(opts.reference))) reference = Number(opts.reference);
    for (i = 0; reference === null && i < points.length; i += 1) {
      if (isFinite(Number(points[i].reference))) reference = Number(points[i].reference);
    }

    var dom = domain(values, reference === null ? [] : [reference]);
    var y = scaler(dom, f.y0, f.ih);
    var slot = f.iw / points.length;

    /* Step geometry: hold the value across the day, then jump. */
    var xs = [];
    var ys = [];
    var stepX = [];
    var stepY = [];
    for (i = 0; i < points.length; i += 1) {
      var left = f.x0 + i * slot;
      var right = left + slot;
      var yv = y(values[i]);
      stepX.push(left); stepY.push(yv);
      stepX.push(right); stepY.push(yv);
      xs.push(left + slot / 2);
      ys.push(yv);
    }

    var out = svgOpen({
      w: f.w, h: f.h, id: id, cls: "chart chart--trail",
      title: opts.title, desc: opts.desc,
      extra: navAttrs(id, points.length)
    });

    /* At most two reference lines: the opening allowance, and zero when the
       series actually goes negative. */
    if (reference !== null) {
      out += lineTag(f.x0, y(reference), f.x0 + f.iw, y(reference), "var(--ink-dim)", W_REF,
        CRISP + ' stroke-dasharray="3 3"');
    }
    if (dom.lo < 0 && dom.hi > 0) {
      out += rule(f.x0, y(0), f.x0 + f.iw, y(0), "var(--rule)", W_REF);
    }

    out += pathTag(poly(stepX, stepY), "var(--dial)", W_SERIES);
    /* The last reading is the one that answers today's question. */
    out += '<circle cx="' + r1(xs[xs.length - 1]) + '" cy="' + r1(ys[ys.length - 1]) +
      '" r="' + (W_MARK) + '" fill="var(--dial)"/>';
    out += cursorTags(f);

    out += yReadings(f, dom, fmt);
    out += xReadings(f, dates, fmtDate);
    if (f.labels) {
      out += stackLabels([
        { x: f.x0 + f.iw + 6, y: ys[ys.length - 1] + 3, text: clip(opts.seriesLabel, 12), fill: "var(--ink-dim)" },
        reference === null ? null
          : { x: f.x0 + f.iw + 6, y: y(reference) + 3, text: clip(opts.referenceLabel, 12), fill: "var(--ink-dim)" }
      ], f.y0 + 8, f.y0 + f.ih, 12);
    }

    remember(id, { xs: xs, ys: ys, onReadout: opts.onReadout });
    return out + "</svg>";
  };

  /* Q: what shape does the month have — where are the salary day, the weekend
     spikes, the dead days? One 3px bar per day from a middle line: income up
     in --gauge, expense down in --dial. A pie cannot show a pattern in time;
     this can, and 31 days still fit in a phone strip. */
  Charts.dayFlow = function (flow, opts) {
    opts = opts || {};
    var raw = list(flow);
    var days = [];
    var i;
    for (i = 0; i < raw.length; i += 1) {
      if (raw[i] && typeof raw[i] === "object") days.push(raw[i]);
    }
    if (!days.length) return empty(opts, 620, 120);

    var fmt = valueFormatter(opts);
    var fmtDate = dateFormatter(opts);
    var f = frame(opts, { w: 620, h: 120, t: 12, r: 76, b: 18, l: 56 });
    var id = uid();

    var ins = [];
    var outs = [];
    var dates = [];
    var peak = 0;
    for (i = 0; i < days.length; i += 1) {
      var a = Math.abs(fin(days[i].inAmount, 0));
      var b = Math.abs(fin(days[i].outAmount, 0));
      ins.push(a);
      outs.push(b);
      dates.push(days[i].date);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    /* All zeros is a real month (nothing spent yet): keep the baseline, give
       the scale an artificial ceiling so no bar divides by zero. */
    var ceiling = peak > 0 ? peak : 1;

    var slot = f.iw / days.length;
    var barW = Math.max(1, Math.min(3, slot - 1));
    var mid = f.y0 + f.ih / 2;
    var half = f.ih / 2;

    var out = svgOpen({
      w: f.w, h: f.h, id: id, cls: "chart chart--flow",
      title: opts.title, desc: opts.desc,
      extra: navAttrs(id, days.length)
    });

    var xs = [];
    var bars = "";
    var weekends = "";
    for (i = 0; i < days.length; i += 1) {
      var cx = f.x0 + i * slot + slot / 2;
      xs.push(cx);
      var x = cx - barW / 2;
      if (ins[i] > 0) {
        bars += rect(x, mid - (ins[i] / ceiling) * half, barW, (ins[i] / ceiling) * half, "var(--gauge)");
      }
      if (outs[i] > 0) {
        bars += rect(x, mid, barW, (outs[i] / ceiling) * half, "var(--dial)");
      }
      if (days[i].weekend) {
        weekends += rect(cx - 1.5, mid - 1, 3, 2, "var(--ink-dim)", ' opacity="0.5"');
      }
    }

    out += rule(f.x0, mid, f.x0 + f.iw, mid, "var(--rule)", W_REF);
    out += weekends;
    out += bars;
    out += cursorTags(f);

    if (f.labels) {
      out += label(f.x0 - 6, f.y0 + 8, fmt(ceiling), "var(--ink-dim)", "end");
      out += label(f.x0 - 6, mid + 4, fmt(0), "var(--ink-dim)", "end");
      out += label(f.x0 - 6, f.y0 + f.ih, fmt(ceiling), "var(--ink-dim)", "end");
      out += xReadings(f, dates, fmtDate);
      out += stackLabels([
        { x: f.x0 + f.iw + 6, y: f.y0 + 8, text: clip(opts.inLabel, 12), fill: "var(--ink-dim)" },
        { x: f.x0 + f.iw + 6, y: f.y0 + f.ih, text: clip(opts.outLabel, 12), fill: "var(--ink-dim)" }
      ], f.y0 + 8, f.y0 + f.ih, 12);
    }

    remember(id, { xs: xs, ys: null, onReadout: opts.onReadout });
    return out + "</svg>";
  };

  /* Q: am I ahead of the pace, and if I fell behind, on which day?
     Cumulative spend against the straight line the limit would draw if it were
     spread evenly, with last period's trace behind it as a ghost. The crossing
     day gets a tick and a sentence, because that is the day worth remembering. */
  Charts.cumulative = function (data, opts) {
    opts = opts || {};
    var source = data && typeof data === "object" ? data : {};
    var points = list(source.points);
    if (!points.length) return empty(opts, 620, 180);

    var fmt = valueFormatter(opts);
    var fmtDate = dateFormatter(opts);
    var f = frame(opts, { w: 620, h: 180, t: 12, r: 84, b: 20, l: 60 });
    var id = uid();

    var totals = [];
    var dates = [];
    var i;
    for (i = 0; i < points.length; i += 1) {
      totals.push(fin(points[i] && points[i].total, 0));
      dates.push(points[i] && points[i].date);
    }

    var pace = list(source.pace);
    var ghost = list(source.ghost);
    var extras = [0];
    for (i = 0; i < pace.length; i += 1) extras.push(fin(pace[i] && pace[i].total, 0));
    for (i = 0; i < ghost.length; i += 1) extras.push(fin(ghost[i] && ghost[i].total, 0));

    var dom = domain(totals, extras);
    var y = scaler(dom, f.y0, f.ih);
    /* All three series share one x grid: the longest of them sets the span so
       a shorter current month stops halfway across, which is honest. */
    var span = Math.max(points.length, pace.length, ghost.length);
    var step = span > 1 ? f.iw / (span - 1) : 0;
    var atX = function (index) {
      return f.x0 + index * step;
    };

    var xs = [];
    var ys = [];
    for (i = 0; i < points.length; i += 1) {
      xs.push(atX(i));
      ys.push(y(totals[i]));
    }

    var out = svgOpen({
      w: f.w, h: f.h, id: id, cls: "chart chart--cumulative",
      title: opts.title, desc: opts.desc,
      extra: navAttrs(id, points.length)
    });

    out += rule(f.x0, y(dom.lo < 0 ? 0 : dom.lo), f.x0 + f.iw, y(dom.lo < 0 ? 0 : dom.lo), "var(--rule)", W_REF);

    var ghostY = null;
    if (ghost.length > 1) {
      var gx = [];
      var gy = [];
      for (i = 0; i < ghost.length; i += 1) {
        gx.push(atX(i));
        gy.push(y(fin(ghost[i] && ghost[i].total, 0)));
      }
      ghostY = gy[gy.length - 1];
      out += pathTag(poly(gx, gy), "var(--ink-dim)", W_REF, ' stroke-dasharray="1 3"');
    }

    var paceY = null;
    if (pace.length > 1) {
      var px = [];
      var py = [];
      for (i = 0; i < pace.length; i += 1) {
        px.push(atX(i));
        py.push(y(fin(pace[i] && pace[i].total, 0)));
      }
      paceY = py[py.length - 1];
      out += pathTag(poly(px, py), "var(--dial)", W_REF, ' stroke-dasharray="3 2"');
    }

    if (points.length > 1) {
      var base = y(dom.lo < 0 ? 0 : dom.lo);
      var area = poly(xs, ys) + " L" + r1(xs[xs.length - 1]) + " " + r1(base) +
        " L" + r1(xs[0]) + " " + r1(base) + " Z";
      out += '<path d="' + area + '" fill="var(--dial)" fill-opacity="' + FILL_OPACITY + '" stroke="none"/>';
      out += pathTag(poly(xs, ys), "var(--dial)", W_SERIES);
    } else {
      out += '<circle cx="' + r1(xs[0]) + '" cy="' + r1(ys[0]) + '" r="' + W_MARK + '" fill="var(--dial)"/>';
    }

    if (source.crossedOn) {
      var hit = -1;
      for (i = 0; i < dates.length; i += 1) {
        if (dates[i] === source.crossedOn) hit = i;
      }
      if (hit >= 0) {
        out += lineTag(xs[hit], ys[hit] - 6, xs[hit], ys[hit] + 6, "var(--over)", W_MARK, CRISP);
        if (f.labels) {
          var cx2 = xs[hit] + 5;
          var anchor = cx2 > f.x0 + f.iw * 0.7 ? "end" : "start";
          out += label(anchor === "end" ? xs[hit] - 5 : cx2, ys[hit] - 10,
            clip(opts.crossedLabel, 28), "var(--ink-dim)", anchor);
        }
      }
    }

    out += cursorTags(f);
    out += yReadings(f, dom, fmt);
    out += xReadings(f, dates, fmtDate);
    if (f.labels) {
      out += stackLabels([
        { x: f.x0 + f.iw + 6, y: ys[ys.length - 1] + 3, text: clip(opts.seriesLabel, 12), fill: "var(--ink-dim)" },
        paceY === null ? null : { x: f.x0 + f.iw + 6, y: paceY + 3, text: clip(opts.paceLabel, 12), fill: "var(--ink-dim)" },
        ghostY === null ? null : { x: f.x0 + f.iw + 6, y: ghostY + 3, text: clip(opts.ghostLabel, 12), fill: "var(--ink-dim)" }
      ], f.y0 + 8, f.y0 + f.ih, 12);
    }

    remember(id, { xs: xs, ys: ys, onReadout: opts.onReadout });
    return out + "</svg>";
  };

  /* Q: is the portfolio worth more than it was?
     Moon.Model.investmentSeries() hands over one reading per date a price was
     typed on, oldest first, and this is the same machinery Charts.cumulative
     uses — one line, one soft fill, no gridlines. A second chart language in
     one application is one too many.
     Two readings make a trend. One makes a dot, and a dot stretched into a
     flat line would claim a year of standing still, so a single price falls
     back to the sentence the caller brought instead. */
  Charts.valueSeries = function (points, opts) {
    opts = opts || {};
    var raw = list(points);
    var kept = [];
    var i;
    for (i = 0; i < raw.length; i += 1) {
      if (raw[i] && typeof raw[i] === "object" && isFinite(Number(raw[i].value))) kept.push(raw[i]);
    }
    if (kept.length < 2) return empty(opts, 380, 72);

    var fmt = valueFormatter(opts);
    var fmtDate = dateFormatter(opts);
    /* 380 wide, not the 620 the panel's charts use: this one lives in a card
       on a phone, and a viewBox twice its rendered width would print its two
       money readings at half the size of every other label on the screen.
       No left gutter either — it prints two readings, not a y axis, so the
       plot gets the width three ticks would have taken. */
    var f = frame(opts, { w: 380, h: 96, t: 16, r: 10, b: 16, l: 10 });
    var id = uid();

    var values = [];
    var dates = [];
    for (i = 0; i < kept.length; i += 1) {
      values.push(Number(kept[i].value));
      dates.push(kept[i].date);
    }

    var dom = domain(values);
    var y = scaler(dom, f.y0, f.ih);
    var step = f.iw / (kept.length - 1);
    var xs = [];
    var ys = [];
    for (i = 0; i < kept.length; i += 1) {
      xs.push(f.x0 + i * step);
      ys.push(y(values[i]));
    }

    var out = svgOpen({
      w: f.w, h: f.h, id: id, cls: "chart chart--value",
      title: opts.title, desc: opts.desc,
      extra: navAttrs(id, kept.length)
    });

    /* A portfolio that is under water hangs from zero, not from the floor of
       its own range: a fill measured from the lowest reading would draw the
       worst month as an empty chart and the second-worst as a gain. */
    var base = y(dom.lo < 0 ? 0 : dom.lo);
    if (dom.lo < 0 && dom.hi > 0) {
      out += rule(f.x0, base, f.x0 + f.iw, base, "var(--rule)", W_REF);
    }

    var area = poly(xs, ys) + " L" + r1(xs[xs.length - 1]) + " " + r1(base) +
      " L" + r1(xs[0]) + " " + r1(base) + " Z";
    out += '<path d="' + area + '" fill="var(--accent)" fill-opacity="' + FILL_OPACITY + '" stroke="none"/>';
    out += pathTag(poly(xs, ys), "var(--accent)", W_SERIES);
    /* The last reading is today's answer, so it is the one that gets a mark. */
    out += '<circle cx="' + r1(xs[xs.length - 1]) + '" cy="' + r1(ys[ys.length - 1]) +
      '" r="' + W_MARK + '" fill="var(--accent)"/>';
    out += cursorTags(f);

    if (f.labels) {
      out += label(f.x0, Math.max(f.y0 - 5, ys[0] - 7), fmt(values[0]), "var(--ink-dim)", "start");
      out += label(f.x0 + f.iw, Math.max(f.y0 - 5, ys[ys.length - 1] - 7),
        fmt(values[values.length - 1]), "var(--ink)", "end");
      out += xReadings(f, dates, fmtDate);
    }

    remember(id, { xs: xs, ys: ys, onReadout: opts.onReadout });
    return out + "</svg>";
  };

  /* Q: what is the portfolio made of?
     §2.6 bans the pie and the donut, and rightly — nobody reads an angle. One
     bar divided by value answers the same question in a line of type's worth
     of height, and the legend beneath it carries the names and the numbers as
     text, which an angle never does.
     Negatives: a stacked bar shows parts of a whole, and a part cannot be
     negative without making the other shares lie. A holding worth less than
     nothing therefore takes no width and is left out of the total, but it
     KEEPS its legend entry, so a loss is reported rather than quietly
     dropped. When nothing is left to divide, the chart says so instead of
     drawing an empty frame.
     There is no y axis and no date band here, so this is the second chart in
     the file (after yearGrid) that measures its own box rather than asking
     frame() for a plot; its height is the legend's, not the caller's. */
  Charts.stackedBar = function (segments, opts) {
    opts = opts || {};
    var raw = list(segments);
    var items = [];
    var i;

    var pad = 2;
    var w = pos(opts.width, 380);
    var avail = Math.max(16, w - pad * 2);

    /* The legend used to cut every name at 24 characters, which is shorter than
       the sentence the investments view has to say about a kind, so entries
       came out broken mid-word. There is no fixed limit now: an entry may run
       to whatever the widest line can hold, and the ellipsis only appears when
       the chart genuinely has no room, because SVG text does not wrap and a
       name past the edge is worse than a name cut at it. */
    var keyMax = Math.max(8, Math.floor((avail - KEY_IN) / KEY_CHAR));

    for (i = 0; i < raw.length; i += 1) {
      if (!raw[i] || typeof raw[i] !== "object") continue;
      var style = toneStyle(raw[i].tone);
      items.push({
        text: clip(raw[i].label, keyMax),
        value: fin(raw[i].value, 0),
        tone: style,
        paint: style ? "var(--tone)" : spectrumVar(items.length)
      });
    }

    var drawn = [];
    var total = 0;
    for (i = 0; i < items.length; i += 1) {
      if (items[i].value > 0) {
        total += items[i].value;
        drawn.push(items[i]);
      }
    }
    if (!(total > 0)) return empty(opts, w, 36);

    var id = uid();
    var room = Math.max(SEG_MIN * drawn.length, avail - (drawn.length - 1) * SEG_GAP);
    var widths = [];
    for (i = 0; i < drawn.length; i += 1) widths.push(drawn[i].value / total * room);

    /* A sliver narrower than the eye can catch is the same as a lie, so every
       segment is lifted to a readable minimum and the difference is taken back
       from the segments that can spare it. One pass settles it: the floor is
       never more than an equal share, so there is always more spare than
       deficit. */
    var floorW = Math.min(SEG_MIN, room / drawn.length);
    var deficit = 0;
    var spare = 0;
    for (i = 0; i < widths.length; i += 1) {
      if (widths[i] < floorW) deficit += floorW - widths[i];
      else spare += widths[i] - floorW;
    }
    if (deficit > 0 && spare > 0) {
      var take = Math.min(1, deficit / spare);
      for (i = 0; i < widths.length; i += 1) {
        widths[i] = widths[i] < floorW ? floorW : floorW + (widths[i] - floorW) * (1 - take);
      }
    }

    /* The legend wraps by estimate: SVG cannot measure text, so an entry is
       charged for its longest plausible glyph width and the line breaks early
       rather than running off the edge. The estimate is in KEY_SIZE units
       because that is the size the group declares, and the two have to be the
       same number or the arithmetic is about type nobody is rendering. */
    var keyTop = pad + SEG_H + 12;
    var cx = pad;
    var lines = 1;
    var key = "";
    for (i = 0; i < items.length; i += 1) {
      var entryW = KEY_IN + items[i].text.length * KEY_CHAR + KEY_OUT;
      if (cx > pad && cx + entryW > w - pad) {
        cx = pad;
        lines += 1;
      }
      var by = keyTop + (lines - 1) * KEY_LINE;
      key += '<circle cx="' + r1(cx + 4) + '" cy="' + r1(by - 4) + '" r="3.5" fill="' +
        items[i].paint + '"' + items[i].tone + "/>";
      key += label(cx + KEY_IN, by, items[i].text, "var(--ink-dim)", "start", null);
      cx += entryW;
    }

    var h = keyTop + (lines - 1) * KEY_LINE + 5;
    var out = svgOpen({
      w: w, h: h, id: id, cls: "chart kindbar",
      ariaLabel: opts.ariaLabel,
      title: opts.title, desc: opts.desc
    });

    var x = pad;
    for (i = 0; i < widths.length; i += 1) {
      out += pill(x, pad, widths[i], SEG_H, SEG_H / 2, drawn[i].paint,
        ' class="kindbar__seg"' + drawn[i].tone);
      x += widths[i] + SEG_GAP;
    }
    out += '<g class="kindbar__key" style="font-size:' + KEY_SIZE + 'px">' + key + "</g>";

    return out + "</svg>";
  };

  /* Q: across a year, which categories are heavy and when?
     G2: density is LINE SPACING, not colour — 8/5/3/2px contour rules. It
     survives colour blindness, both themes and a black-and-white printer, and
     it looks like nothing a dashboard library ships. */
  Charts.yearGrid = function (grid, opts) {
    opts = opts || {};
    var source = grid && typeof grid === "object" ? grid : {};
    var periods = list(source.periods);
    var rows = [];
    var raw = list(source.rows);
    var i;
    var j;
    for (i = 0; i < raw.length; i += 1) {
      if (raw[i] && typeof raw[i] === "object") rows.push(raw[i]);
    }
    if (!periods.length || !rows.length) return empty(opts, 620, 120);

    var SPACING = [0, 8, 5, 3, 2];
    var id = uid();
    var labelW = pos(opts.labelWidth, 104);
    var cellH = pos(opts.cellHeight, 18);
    var headerH = 16;
    var keyH = 30;
    var padL = 0;
    var padR = 8;
    var w = pos(opts.width, 620);
    var cellW = Math.max(8, (w - labelW - padL - padR) / periods.length);
    var gridX = padL + labelW;
    var gridY = headerH + 4;
    var gridH = rows.length * cellH;
    var h = gridY + gridH + keyH;

    var monthLabels = list(opts.monthLabels);

    var out = svgOpen({
      w: w, h: h, id: id, cls: "chart chart--year",
      title: opts.title, desc: opts.desc
    });

    /* One pattern set for the whole chart; every cell points at it. */
    out += "<defs>";
    for (i = 1; i < SPACING.length; i += 1) {
      out += '<pattern id="d' + i + id + '" width="4" height="' + SPACING[i] +
        '" patternUnits="userSpaceOnUse">' +
        lineTag(0, 0.5, 4, 0.5, "var(--ink-dim)", W_REF) +
        "</pattern>";
    }
    out += "</defs>";

    /* Month abbreviations come in as finished strings; the fallback is the
       two-digit month number, which needs no language. */
    for (i = 0; i < periods.length; i += 1) {
      var mLabel = monthLabels[i];
      if (mLabel === undefined || mLabel === null || mLabel === "") {
        mLabel = String(periods[i] || "").slice(5) || String(i + 1);
      }
      out += label(gridX + i * cellW + cellW / 2, headerH - 4, clip(mLabel, 4), "var(--ink-dim)", "middle");
    }

    for (i = 0; i < rows.length; i += 1) {
      var rowY = gridY + i * cellH;
      out += label(padL, rowY + cellH / 2 + 3, clip(rows[i].name, Math.max(6, Math.floor(labelW / 6))),
        "var(--ink-dim)", "start");

      var cells = list(rows[i].cells);
      for (j = 0; j < periods.length; j += 1) {
        var cell = null;
        var k;
        for (k = 0; k < cells.length; k += 1) {
          if (cells[k] && cells[k].period === periods[j]) cell = cells[k];
        }
        if (!cell && cells.length === periods.length) cell = cells[j];
        var density = cell ? Math.round(fin(cell.density, 0)) : 0;
        if (density < 0) density = 0;
        if (density > 4) density = 4;
        if (density > 0) {
          out += rect(gridX + j * cellW + 1, rowY + 1, cellW - 2, cellH - 2,
            "url(#d" + density + id + ")");
        }
      }
      if (i > 0) {
        out += rule(gridX, rowY, gridX + periods.length * cellW, rowY, "var(--rule)", W_REF);
      }
    }

    /* Frame and month separators: the table's own structure, not a data grid. */
    out += rule(gridX, gridY, gridX + periods.length * cellW, gridY, "var(--rule)", W_REF);
    out += rule(gridX, gridY + gridH, gridX + periods.length * cellW, gridY + gridH, "var(--rule)", W_REF);
    for (i = 0; i <= periods.length; i += 1) {
      out += rule(gridX + i * cellW, gridY, gridX + i * cellW, gridY + gridH, "var(--rule)", W_REF);
    }

    /* Density key: the legend this chart is allowed to have, because the
       encoding itself needs teaching once. */
    var keyY = gridY + gridH + 12;
    var keyX = gridX;
    out += label(padL, keyY + 9, clip(opts.keyLabel, Math.max(6, Math.floor(labelW / 6))), "var(--ink-dim)", "start");
    for (i = 0; i < SPACING.length; i += 1) {
      var swatchW = Math.min(28, cellW);
      var sx = keyX + i * (swatchW + 8);
      if (i > 0) out += rect(sx, keyY, swatchW, 12, "url(#d" + i + id + ")");
      out += rule(sx, keyY + 12, sx + swatchW, keyY + 12, "var(--rule)", W_REF);
      out += label(sx + swatchW / 2, keyY + 24, String(i), "var(--ink-dim)", "middle");
    }

    return out + "</svg>";
  };

  /* Q: where does this category's reading stand against its limit, and against
     where the month says it should be?
     One bar, in the category's own ink, with fully rounded ends — the shape
     every budget application on a phone uses, because it is the one a reader
     already knows how to read. Three marks survived the ruler it replaced,
     each because it answers a question the bar alone cannot: the cap says
     where the limit is (and js/views.limits.js hangs a draggable grip on it),
     the notch cut through the bar says where the month expects you to be, and
     the run past the cap says you are over.
     G1 still holds: an overrun does NOT stay inside a tidy bar. It crosses the
     cap and reaches into the readout column, so nine rows lose their perfect
     right edge and the eye catches the broken alignment before it reads a
     single number. Renormalising only kicks in above 150% as a safety valve. */
  Charts.meter = function (row, opts) {
    opts = opts || {};
    var r = row && typeof row === "object" ? row : {};
    var limit = fin(r.limit, 0);
    var spent = fin(r.spent, 0);
    if (limit <= 0) return empty(opts, 420, 32);

    var trackW = pos(opts.trackWidth, 240);
    var readoutW = pos(opts.readoutWidth, 132);
    var labelW = pos(opts.labelWidth, 0);
    var h = pos(opts.height, METER_H);
    var w = labelW + trackW + readoutW + 8;
    var id = uid();

    var ratio = spent / limit;
    if (!isFinite(ratio) || ratio < 0) ratio = 0;
    var pct = isFinite(Number(r.pct)) ? Math.round(Number(r.pct)) : Math.round(ratio * 100);

    var maxSpill = Math.max(12, readoutW - 8);
    /* Below 150% one unit of scale is fixed, so 105% and 140% look different —
       the whole point of G1. Above it, squeeze everything into the room left
       so the bar cannot run off the viewBox. */
    var unit = trackW;
    if (ratio > RENORM_AT) unit = (trackW + maxSpill) / ratio;

    var x0 = labelW + 4;
    var yc = h / 2;
    var barH = Math.max(10, Math.min(BAR_H, h - 10));
    var barTop = yc - barH / 2;
    var xAt = function (t) {
      return x0 + t * unit;
    };
    var capX = xAt(1);
    var fillEnd = xAt(Math.min(ratio, 1));
    var spillEnd = Math.min(capX + (ratio > 1 ? (ratio - 1) * unit : 0), x0 + trackW + maxSpill);

    var overColor = opts.overflowMark === "flare" ? "var(--flare)" : "var(--over)";
    var over = ratio > 1;
    var tone = "var(--tone, var(--accent))";

    var percentText = opts.percentText;
    if (percentText === undefined || percentText === null || percentText === "") {
      percentText = opts.percentFirst ? "%" + pct : pct + "%";
    }

    /* The overrun used to be hatched, and a reading printed on top of a hatch
       is still legible. It is solid ink now, so the paint stops short of the
       percentage instead of burying it: the number is the exact measure, the
       run past the cap only has to say "past", and above 150% the scale is
       already a squeeze rather than a measurement. */
    var readRoom = Math.min(readoutW - 8, 10 + String(percentText).length * 7);
    var paintEnd = Math.max(capX, Math.min(spillEnd, w - 4 - readRoom));
    var shellEnd = over ? paintEnd : capX;

    var ariaLabel = opts.ariaLabel || opts.title || "";
    var out = svgOpen({
      w: w, h: h, id: id, cls: "chart meter",
      role: "meter",
      ariaLabel: ariaLabel,
      title: opts.title || ariaLabel,
      desc: opts.desc || ariaLabel,
      extra: ' aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="' + Math.max(100, pct) + '"'
    });

    /* One rounded shell for the whole bar, and the bands painted inside it:
       that is what lets the bar carry two colours and still have exactly one
       pair of round ends, whatever the ratio does. */
    out += '<defs><clipPath id="bar' + id + '">' +
      pill(x0, barTop, shellEnd - x0, barH, barH / 2, "none") + "</clipPath>";
    if (over) out += hatchPattern(id, "var(--surface)");
    out += "</defs>";

    if (labelW > 0 && opts.label) {
      out += label(0, yc + 4, clip(opts.label, Math.max(6, Math.floor(labelW / 6))), "var(--ink)", "start", 13);
    }

    out += '<g clip-path="url(#bar' + id + ')">';
    /* The unspent remainder keeps the category's colour at a sixth of its
       strength, so an untouched limit still says whose limit it is. */
    out += rect(x0, barTop, capX - x0, barH, tone, ' fill-opacity="0.16"');
    if (fillEnd > x0) out += rect(x0, barTop, fillEnd - x0, barH, tone);
    if (over) {
      out += rect(capX, barTop, paintEnd - capX, barH, overColor);
      out += rect(capX, barTop, paintEnd - capX, barH, "url(#hatch" + id + ")");
    }
    out += "</g>";

    /* Pace is cut INTO the bar rather than drawn over it. A hairline on top of
       a saturated fill is the first mark to disappear for a reader who cannot
       separate two hues; a gap in the fill survives that, and monochrome. */
    var paceRatio = Number(r.paceRatio);
    if (isFinite(paceRatio) && paceRatio >= 0) {
      var paceX = xAt(Math.min(paceRatio, 1));
      out += rect(paceX - 1.5, barTop - 2, 3, barH + 4, "var(--surface)");
      out += rule(paceX, barTop - 2, paceX, barTop + barH + 2, "var(--ink-dim)", W_REF);
    }

    /* The cap. Under the limit the track simply ends there and the rounded end
       is the mark; past it the bar runs on, so the break in the fill is what
       says where the limit was. The tick above the bar is drawn either way,
       because this x is where views.limits.js parks its drag grip and a reader
       about to take hold of it should be able to see what they are grabbing. */
    if (over) out += rect(capX - 1, barTop, 2, barH, "var(--surface)");
    out += rule(capX, Math.max(0.5, barTop - 5), capX, Math.max(4, barTop - 1),
      over ? overColor : "var(--ink-dim)", W_REF);

    /* Readout. A 24-unit row has one line of reading in it; the drift sentence
       is printed beside the chart in a .meter__drift node (js/views.limits.js
       already does exactly that) and only lands inside the SVG when a caller
       has asked for a tall enough meter to hold two lines. */
    var readX = w - 4;
    var twoLine = !!opts.driftText && h >= 36;
    out += label(readX, twoLine ? yc - 6 : yc + 4.5, percentText,
      over ? overColor : "var(--ink)", "end", 13);
    if (twoLine) {
      out += label(readX, yc + 14, clip(opts.driftText, 28), over ? overColor : "var(--ink-dim)", "end");
    }

    return out + "</svg>";
  };

  /* Q: how much of the period has passed?
     A10: the circle never grows and this is not a phase. The reading is the
     position of the vertical boundary across the diameter; the passed side is
     shaded at 35%, the rest is empty. Calendar time only — money is the dial's
     job. */
  Charts.moonDisc = function (ratio, opts) {
    opts = opts || {};
    var size = pos(opts.size, 28);
    var id = uid();
    var t = Math.max(0, Math.min(1, fin(ratio, 0)));
    var r = (size - 2) / 2;
    var c = size / 2;

    var ariaLabel = opts.ariaLabel || "";
    var out = svgOpen({
      w: size, h: size, id: id, cls: "chart disc", maxW: size,
      title: opts.title || ariaLabel,
      desc: opts.desc || ariaLabel
    });
    out += discMarkup(c, c, r, t);
    return out + "</svg>";
  };

  /* --------------------------------------------------------- self testing */

  /* Runs every function against empty, single, normal and extreme data and
     checks the returned string is balanced XML with no NaN/undefined in it.
     No DOMParser: this has to pass under plain node as well as a browser. */
  function balanced(markup) {
    var stack = [];
    var re = /<(\/?)([A-Za-z][A-Za-z0-9:_.-]*)([^>]*)>/g;
    var match;
    while ((match = re.exec(markup)) !== null) {
      var closing = match[1] === "/";
      var name = match[2];
      var tail = match[3] || "";
      var selfClosing = /\/\s*$/.test(tail);
      if (closing) {
        if (!stack.length || stack[stack.length - 1] !== name) {
          return "unbalanced close </" + name + ">";
        }
        stack.pop();
      } else if (!selfClosing) {
        stack.push(name);
      }
      var quotes = tail.split('"').length - 1;
      if (quotes % 2 !== 0) return "odd quote count in <" + name + ">";
    }
    if (stack.length) return "unclosed <" + stack[stack.length - 1] + ">";
    return null;
  }

  function checkMarkup(markup) {
    if (typeof markup !== "string" || !markup) return "not a string";
    if (markup.indexOf("<svg ") !== 0) return "root is not svg";
    if (/NaN|undefined|Infinity/.test(markup)) return "contains NaN/undefined/Infinity";
    if (markup.indexOf("<title") === -1) return "missing title";
    if (markup.indexOf("<desc") === -1) return "missing desc";
    /* Colour may only arrive as a CSS variable: no raw hex in this file. */
    if (/(?:fill|stroke)="#/.test(markup)) return "raw hex colour";
    return balanced(markup);
  }

  Charts._selftest = function () {
    var failures = [];
    var count = 0;

    function run(name, kase, fn) {
      count += 1;
      var markup;
      try {
        markup = fn();
      } catch (e) {
        failures.push({ chart: name, "case": kase, problem: "threw: " + (e && e.message) });
        return;
      }
      var problem = checkMarkup(markup);
      if (problem) failures.push({ chart: name, "case": kase, problem: problem });
      return markup;
    }

    /* The meter's geometry is a contract with js/views.limits.js, which lays a
       draggable grip over the limit cap and converts the pointer's pixels back
       into money against this viewBox. Nothing in the suite would notice the
       cap moving — the drag would simply write the wrong figure — so the two
       numbers it depends on are asserted here. */
    function geometry(name, kase, markup, needle) {
      count += 1;
      if (String(markup).indexOf(needle) === -1) {
        failures.push({ chart: name, "case": kase, problem: "expected " + needle });
      }
    }

    function absent(name, kase, markup, needle) {
      count += 1;
      if (String(markup).indexOf(needle) !== -1) {
        failures.push({ chart: name, "case": kase, problem: "did not expect " + needle });
      }
    }

    function expect(name, kase, ok, problem) {
      count += 1;
      if (!ok) failures.push({ chart: name, "case": kase, problem: problem });
    }

    /* The legend is the only part of this file whose box grows with the data,
       so its height is how a test can tell a wrapped legend from one printing
       seven lines on top of each other. */
    function boxHeight(markup) {
      var m = /viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(String(markup));
      return m ? Number(m[1]) : NaN;
    }

    function legendOf(markup) {
      var s = String(markup);
      var at = s.indexOf('<g class="kindbar__key"');
      return at === -1 ? "" : s.slice(at);
    }

    function trail(n, mode) {
      var out = [];
      var i;
      for (i = 0; i < n; i += 1) {
        var v = 41260;
        if (mode === "zero") v = 0;
        if (mode === "negative") v = -1000 * i;
        if (mode === "wave") v = 41260 + Math.round(Math.sin(i) * 9000);
        out.push({ date: "2026-09-" + (i < 9 ? "0" : "") + (i + 1), perDay: v, reference: mode === "zero" ? 0 : 41260 });
      }
      return out;
    }

    function flow(n, mode) {
      var out = [];
      var i;
      for (i = 0; i < n; i += 1) {
        out.push({
          date: "2026-09-" + (i < 9 ? "0" : "") + (i + 1),
          inAmount: mode === "zero" ? 0 : (i === 3 ? 4200000 : 0),
          outAmount: mode === "zero" ? 0 : (mode === "negative" ? -2000 : 1000 * (i + 1)),
          weekend: i % 7 === 5 || i % 7 === 6
        });
      }
      return out;
    }

    function cum(n, mode) {
      var points = [];
      var pace = [];
      var ghost = [];
      var total = 0;
      var i;
      for (i = 0; i < n; i += 1) {
        total += mode === "zero" ? 0 : 12000;
        points.push({ date: "2026-09-" + (i < 9 ? "0" : "") + (i + 1), total: total });
        pace.push({ date: "2026-09-" + (i < 9 ? "0" : "") + (i + 1), total: 10000 * (i + 1) });
        ghost.push({ date: "2026-08-" + (i < 9 ? "0" : "") + (i + 1), total: 9000 * (i + 1) });
      }
      return {
        points: points,
        pace: mode === "bare" ? [] : pace,
        ghost: mode === "bare" ? null : ghost,
        crossedOn: n > 4 ? "2026-09-05" : null
      };
    }

    /* A price history as Moon.Model.investmentSeries() hands it over: one
       reading per date, oldest first, in minor units. */
    function series(n, mode) {
      var out = [];
      var i;
      for (i = 0; i < n; i += 1) {
        var v = 4200000 + 90000 * i;
        if (mode === "flat") v = 4200000;
        if (mode === "wave") v = 4200000 + Math.round(Math.sin(i) * 700000);
        if (mode === "negative") v = 900000 - 180000 * i;
        out.push({ date: "2026-" + (i < 9 ? "0" : "") + ((i % 12) + 1) + "-15", value: v });
      }
      return out;
    }

    function kinds(n, mode) {
      var names = ["Hisse", "Fon", "Kripto", "Altın", "Döviz", "Gayrimenkul", "Diğer"];
      var out = [];
      var i;
      for (i = 0; i < n; i += 1) {
        var name = names[i % names.length];
        /* investments.byKind.row as the catalogue writes it in Turkish: 39
           characters for the shortest kind, which is what the legend has to
           print whole. */
        var text = mode === "sentence"
          ? name + ", 42.000,00 ₺, toplamın %38 kadarı"
          : name + " 1.2 x %12";
        out.push({ label: text, value: 400000 * (n - i) });
      }
      return out;
    }

    function year(rowCount, mode) {
      var periods = [];
      var rows = [];
      var i;
      var j;
      for (i = 0; i < 12; i += 1) {
        periods.push("2026-" + (i < 9 ? "0" : "") + (i + 1));
      }
      for (i = 0; i < rowCount; i += 1) {
        var cells = [];
        for (j = 0; j < 12; j += 1) {
          cells.push({
            period: periods[j],
            amount: 1000 * j,
            density: mode === "wild" ? (j % 9) - 2 : j % 5
          });
        }
        rows.push({ categoryId: "c_" + i, name: "Kategori <" + i + "> çok uzun bir ad örneği", cells: cells });
      }
      return { periods: periods, rows: rows };
    }

    var opts = {
      title: "T",
      desc: "D",
      emptyText: "E",
      seriesLabel: "S",
      referenceLabel: "R",
      paceLabel: "P",
      ghostLabel: "G",
      crossedLabel: "C",
      inLabel: "I",
      outLabel: "O",
      keyLabel: "K",
      formatValue: function (minor) {
        return String(Math.round(minor / 100)) + " x";
      },
      formatDate: function (d) {
        return String(d).slice(8);
      },
      onReadout: function () { /* caller prints the reading */ }
    };

    run("allowanceTrail", "empty", function () { return Charts.allowanceTrail([], opts); });
    run("allowanceTrail", "null", function () { return Charts.allowanceTrail(null, null); });
    run("allowanceTrail", "single", function () { return Charts.allowanceTrail(trail(1), opts); });
    run("allowanceTrail", "normal", function () { return Charts.allowanceTrail(trail(30, "wave"), opts); });
    run("allowanceTrail", "allZero", function () { return Charts.allowanceTrail(trail(30, "zero"), opts); });
    run("allowanceTrail", "negative", function () { return Charts.allowanceTrail(trail(30, "negative"), opts); });
    run("allowanceTrail", "junk", function () {
      return Charts.allowanceTrail([{ date: null, perDay: "x" }, null, { perDay: 5 }], opts);
    });
    run("allowanceTrail", "compact", function () {
      return Charts.allowanceTrail(trail(30, "wave"), { width: 320, height: 40, compact: true, title: "T", desc: "D" });
    });

    run("dayFlow", "empty", function () { return Charts.dayFlow([], opts); });
    run("dayFlow", "undefined", function () { return Charts.dayFlow(undefined, undefined); });
    run("dayFlow", "single", function () { return Charts.dayFlow(flow(1), opts); });
    run("dayFlow", "normal", function () { return Charts.dayFlow(flow(31), opts); });
    run("dayFlow", "allZero", function () { return Charts.dayFlow(flow(31, "zero"), opts); });
    run("dayFlow", "negative", function () { return Charts.dayFlow(flow(31, "negative"), opts); });
    run("dayFlow", "narrow", function () { return Charts.dayFlow(flow(31), { width: 320, height: 60, title: "T", desc: "D" }); });

    run("cumulative", "empty", function () { return Charts.cumulative({ points: [] }, opts); });
    run("cumulative", "null", function () { return Charts.cumulative(null, null); });
    run("cumulative", "single", function () { return Charts.cumulative(cum(1), opts); });
    run("cumulative", "normal", function () { return Charts.cumulative(cum(30), opts); });
    run("cumulative", "allZero", function () { return Charts.cumulative(cum(30, "zero"), opts); });
    run("cumulative", "bare", function () { return Charts.cumulative(cum(30, "bare"), opts); });
    run("cumulative", "junk", function () {
      return Charts.cumulative({ points: [{ date: "2026-09-01", total: "x" }], pace: "no", ghost: 7 }, opts);
    });

    run("yearGrid", "empty", function () { return Charts.yearGrid({ periods: [], rows: [] }, opts); });
    run("yearGrid", "null", function () { return Charts.yearGrid(null, null); });
    run("yearGrid", "single", function () { return Charts.yearGrid(year(1), opts); });
    run("yearGrid", "normal", function () { return Charts.yearGrid(year(8), opts); });
    run("yearGrid", "wildDensity", function () { return Charts.yearGrid(year(8, "wild"), opts); });

    run("meter", "noLimit", function () { return Charts.meter({ spent: 100, limit: 0 }, opts); });
    run("meter", "null", function () { return Charts.meter(null, null); });
    run("meter", "zero", function () {
      return Charts.meter({ spent: 0, limit: 600000, pct: 0, paceRatio: 0 }, opts);
    });
    run("meter", "under", function () {
      return Charts.meter({ name: "Market", spent: 432000, limit: 600000, pct: 72, paceRatio: 0.7, drift: 31000, driftState: "ahead" },
        { title: "T", desc: "D", ariaLabel: "A", percentText: "%72", driftText: "310 x önde", labelWidth: 90, label: "Market" });
    });
    run("meter", "exact", function () {
      return Charts.meter({ spent: 600000, limit: 600000, pct: 100, paceRatio: 1 }, opts);
    });
    run("meter", "over118", function () {
      return Charts.meter({ spent: 708000, limit: 600000, pct: 118, paceRatio: 0.7 },
        { title: "T", desc: "D", ariaLabel: "A", percentText: "%118", driftText: "312 x aştın" });
    });
    run("meter", "over160", function () {
      return Charts.meter({ spent: 960000, limit: 600000, pct: 160, paceRatio: 1 },
        { title: "T", desc: "D", ariaLabel: "A", percentText: "%160" });
    });
    run("meter", "over320flare", function () {
      return Charts.meter({ spent: 1920000, limit: 600000, pct: 320, paceRatio: 0.9 },
        { title: "T", desc: "D", ariaLabel: "A", overflowMark: "flare", percentText: "%320" });
    });
    run("meter", "tall", function () {
      return Charts.meter({ spent: 432000, limit: 600000, pct: 72, paceRatio: 0.7 },
        { title: "T", desc: "D", height: 44, driftText: "310 x önde", percentText: "%72" });
    });
    run("meter", "junk", function () {
      return Charts.meter({ spent: "x", limit: 600000, pct: null, paceRatio: "y" }, opts);
    });

    /* 380 is TRACK_WIDTH + READOUT_WIDTH + 8 and 244 is the cap at
       trackWidth + 4 — the two figures views.limits.js reads the grip's
       percentage out of (VIEW_WIDTH and TRACK_X0 + unit there). At 200% the
       scale renormalises and the cap must land at 4 + (240 + 124) / 2. */
    geometry("meter", "box", run("meter", "contract", function () {
      return Charts.meter({ spent: 432000, limit: 600000, pct: 72, paceRatio: 0.7 },
        { title: "T", desc: "D", trackWidth: 240, readoutWidth: 132 });
    }), 'viewBox="0 0 380 24"');
    geometry("meter", "cap", Charts.meter({ spent: 432000, limit: 600000, pct: 72 },
      { title: "T", desc: "D", trackWidth: 240, readoutWidth: 132 }), 'x1="244"');
    geometry("meter", "capRenormalised", Charts.meter({ spent: 1200000, limit: 600000, pct: 200 },
      { title: "T", desc: "D", trackWidth: 240, readoutWidth: 132 }), 'x1="186"');

    run("valueSeries", "empty", function () { return Charts.valueSeries([], opts); });
    run("valueSeries", "null", function () { return Charts.valueSeries(null, null); });
    run("valueSeries", "single", function () { return Charts.valueSeries(series(1), opts); });
    run("valueSeries", "two", function () { return Charts.valueSeries(series(2), opts); });
    run("valueSeries", "normal", function () { return Charts.valueSeries(series(12, "wave"), opts); });
    run("valueSeries", "flat", function () { return Charts.valueSeries(series(12, "flat"), opts); });
    run("valueSeries", "negative", function () { return Charts.valueSeries(series(12, "negative"), opts); });
    run("valueSeries", "extreme", function () { return Charts.valueSeries(series(400, "wave"), opts); });
    run("valueSeries", "junk", function () {
      return Charts.valueSeries([{ date: null, value: "x" }, null, { value: 500 }, { date: "2026-09-02", value: 900 }], opts);
    });
    run("valueSeries", "narrow", function () {
      return Charts.valueSeries(series(12, "wave"), { width: 320, height: 72, title: "T", desc: "D" });
    });

    run("stackedBar", "empty", function () { return Charts.stackedBar([], opts); });
    run("stackedBar", "null", function () { return Charts.stackedBar(null, null); });
    run("stackedBar", "zeroTotal", function () {
      return Charts.stackedBar([{ label: "Hisse", value: 0 }, { label: "Fon", value: 0 }], opts);
    });
    run("stackedBar", "whole", function () {
      return Charts.stackedBar([{ label: "Hisse <%100>", value: 4200000, tone: "#8AA6FF" }], opts);
    });
    run("stackedBar", "sliver", function () {
      /* 0.3% of the portfolio: it must still be drawn and still be named. */
      return Charts.stackedBar([
        { label: "Hisse", value: 4200000, tone: "#8AA6FF" },
        { label: "Fon", value: 1800000, tone: "#3DD6A0" },
        { label: "Altın", value: 18000, tone: "var(--cat-4)" }
      ], opts);
    });
    run("stackedBar", "negative", function () {
      return Charts.stackedBar([
        { label: "Hisse", value: 4200000, tone: "#8AA6FF" },
        { label: "Kripto", value: -900000, tone: "#FF6F91" }
      ], opts);
    });
    run("stackedBar", "allNegative", function () {
      return Charts.stackedBar([{ label: "Kripto", value: -900000 }], opts);
    });
    run("stackedBar", "sevenKinds", function () {
      return Charts.stackedBar(kinds(7), opts);
    });
    run("stackedBar", "junk", function () {
      return Charts.stackedBar([null, { label: null, value: null, tone: '"><script>' }, { value: 10 }], opts);
    });
    run("stackedBar", "sevenSentences", function () {
      return Charts.stackedBar(kinds(7, "sentence"), opts);
    });
    run("stackedBar", "narrowSentences", function () {
      return Charts.stackedBar(kinds(3, "sentence"), { width: 200, title: "T", desc: "D" });
    });

    geometry("stackedBar", "tone", Charts.stackedBar([{ label: "Hisse", value: 100, tone: "#8AA6FF" }], opts),
      'style="--tone:#8AA6FF"');
    geometry("stackedBar", "legend", Charts.stackedBar([
      { label: "Hisse", value: 4200000 }, { label: "Altın", value: 18000 }
    ], opts), "kindbar__key");

    /* The legend's type size lives in the markup, not in moon.css: the wrap
       estimate above is arithmetic on KEY_SIZE, and a stylesheet quietly
       rendering the same entries larger is exactly how the lines came to
       overlap. The group declares the size once and no entry argues with it. */
    var keySized = Charts.stackedBar(kinds(3), opts);
    geometry("stackedBar", "keySize", keySized, '<g class="kindbar__key" style="font-size:12px">');
    absent("stackedBar", "keySizePerEntry", legendOf(keySized), "font-size=");

    /* The sentence the investments view has to print is 39 characters, and a
       legend that cut it at 24 was the whole defect. */
    var sentences = Charts.stackedBar(kinds(7, "sentence"), opts);
    geometry("stackedBar", "sentenceWhole", sentences, "Gayrimenkul, 42.000,00 ₺, toplamın %38 kadarı");
    absent("stackedBar", "sentenceWhole", legendOf(sentences), "…");
    expect("stackedBar", "sentencesWrap",
      boxHeight(sentences) >= 28 + 6 * 17,
      "seven long entries must take seven legend lines, got height " + boxHeight(sentences));
    expect("stackedBar", "shortStaysShort",
      boxHeight(Charts.stackedBar(kinds(3), opts)) < boxHeight(sentences),
      "short names must not cost the legend the height long ones do");

    /* No room is the one case where the ellipsis is right: 200 units of width
       cannot hold 39 characters, and text past the viewBox is worse than text
       cut inside it. */
    var squeezed = Charts.stackedBar(kinds(2, "sentence"), { width: 200, title: "T", desc: "D" });
    geometry("stackedBar", "narrowClips", legendOf(squeezed), "…");

    run("moonDisc", "zero", function () { return Charts.moonDisc(0, { ariaLabel: "A", title: "T", desc: "D" }); });
    run("moonDisc", "mid", function () { return Charts.moonDisc(0.7, { ariaLabel: "A" }); });
    run("moonDisc", "full", function () { return Charts.moonDisc(1, { ariaLabel: "A" }); });
    run("moonDisc", "outOfRange", function () { return Charts.moonDisc(3.4, { ariaLabel: "A", size: 10 }); });
    run("moonDisc", "negative", function () { return Charts.moonDisc(-2, null); });
    run("moonDisc", "junk", function () { return Charts.moonDisc("x", { size: -5 }); });

    /* The disc takes its colour from the element it is printed on — --accent
       inside .networth__phase, --ink-dim inside the hero pill — so a named
       token baked into the markup would overrule both callers and the card's
       one piece of brand imagery would be grey wherever it was put. */
    var disc = Charts.moonDisc(0.4, { ariaLabel: "A" });
    geometry("moonDisc", "lit", disc, 'fill="currentColor"');
    geometry("moonDisc", "rim", disc, 'stroke="currentColor"');
    absent("moonDisc", "noInkDim", disc, "var(--ink-dim)");
    absent("moonDisc", "noRule", disc, "var(--rule)");

    return { ok: failures.length === 0, total: count, failures: failures };
  };

  Moon.Charts = Charts;
})(window);
