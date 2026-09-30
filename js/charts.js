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
 * arriving, --ink-dim ghosts and labels, --over (or --flare) an overrun,
 * --rule ticks and baselines. No raw hex lives in this file.
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

  function label(x, y, value, fill, anchor, size) {
    if (value === null || value === undefined || value === "") return "";
    return '<text x="' + r1(x) + '" y="' + r1(y) + '" font-size="' + (size || 11) +
      '" fill="' + (fill || "var(--ink-dim)") + '"' +
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
     diameter (x = cx - r + 2r*ratio). Left of it is shaded, right is empty. */
  function discMarkup(cx, cy, r, ratio) {
    var id = uid();
    var t = Math.max(0, Math.min(1, fin(ratio, 0)));
    var edge = cx - r + 2 * r * t;
    /* A clip path uses geometry only, so the mask rect needs no real fill. */
    var out = '<defs><clipPath id="clip' + id + '">';
    out += rect(cx - r, cy - r, edge - (cx - r), 2 * r, "none");
    out += "</clipPath></defs>";
    out += '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(r) +
      '" fill="var(--ink-dim)" opacity="0.35" clip-path="url(#clip' + id + ')"/>';
    out += '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="' + r1(r) +
      '" fill="none" stroke="var(--rule)" stroke-width="' + W_REF + '"' + VE + "/>";
    /* The boundary is the reading, so it is the one crisp line here. */
    out += rule(edge, cy - r, edge, cy + r, "var(--ink-dim)", W_REF);
    return out;
  }

  function hatchPattern(id, color) {
    /* 45 degrees, 3px apart: the second channel of an overrun, readable in
       black and white and immune to colour blindness. */
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
     G1: an overrun does NOT stay inside a tidy bar. The hatched part crosses
     the 100% end cap and spills into the readout column on the right, so nine
     rows lose their perfect right edge and the eye catches the broken
     alignment before it reads a single number. Renormalising only kicks in
     above 150% as a safety valve. */
  Charts.meter = function (row, opts) {
    opts = opts || {};
    var r = row && typeof row === "object" ? row : {};
    var limit = fin(r.limit, 0);
    var spent = fin(r.spent, 0);
    if (limit <= 0) return empty(opts, 420, 40);

    var trackW = pos(opts.trackWidth, 240);
    var readoutW = pos(opts.readoutWidth, 132);
    var labelW = pos(opts.labelWidth, 0);
    var h = pos(opts.height, 44);
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
    if (ratio > 1.5) unit = (trackW + maxSpill) / ratio;

    var x0 = labelW + 4;
    var y = Math.round(h * 0.52);
    var xAt = function (t) {
      return x0 + t * unit;
    };
    var capX = xAt(1);
    var fillEnd = xAt(Math.min(ratio, 1));
    var spillEnd = Math.min(capX + (ratio > 1 ? (ratio - 1) * unit : 0), x0 + trackW + maxSpill);

    var overColor = opts.overflowMark === "flare" ? "var(--flare)" : "var(--over)";
    var over = ratio > 1;

    var ariaLabel = opts.ariaLabel || opts.title || "";
    var out = svgOpen({
      w: w, h: h, id: id, cls: "chart meter",
      role: "meter",
      ariaLabel: ariaLabel,
      title: opts.title || ariaLabel,
      desc: opts.desc || ariaLabel,
      extra: ' aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="' + Math.max(100, pct) + '"'
    });

    if (over) out += "<defs>" + hatchPattern(id, overColor) + "</defs>";

    if (labelW > 0 && opts.label) {
      out += label(0, y + 4, clip(opts.label, Math.max(6, Math.floor(labelW / 6))), "var(--ink)", "start", 13);
    }

    /* The path: 1px baseline, 2px ticks every 10%, 5px at the half, a 9px end
       cap at the limit. Verniers read this way without a single number. */
    out += rule(x0, y, capX, y, "var(--rule)", W_REF);
    var i;
    for (i = 1; i < 10; i += 1) {
      if (i === 5) continue;
      out += rule(xAt(i / 10), y - 1, xAt(i / 10), y + 1, "var(--rule)", W_REF);
    }
    out += rule(xAt(0.5), y - 2.5, xAt(0.5), y + 2.5, "var(--rule)", W_REF);
    out += rule(x0, y - 4.5, x0, y + 4.5, "var(--rule)", W_REF);
    out += rule(capX, y - 4.5, capX, y + 4.5, "var(--rule)", W_REF);

    /* Spend: a 6px column of 22% amber. The information is not the area but
       where its reading edge stops, like mercury in a tube. */
    if (fillEnd > x0) {
      out += rect(x0, y - 3, fillEnd - x0, 6, "var(--dial)", ' fill-opacity="0.22"');
    }
    out += rule(fillEnd, y - 5, fillEnd, y + 5, "var(--dial)", W_MARK);

    if (over) {
      out += rect(capX, y - 3, spillEnd - capX, 6, "url(#hatch" + id + ")");
      out += rect(capX, y - 3, spillEnd - capX, 6, "none", ' stroke="' + overColor +
        '" stroke-width="' + W_REF + '"' + VE + CRISP);
      out += rule(spillEnd, y - 5, spillEnd, y + 5, overColor, W_MARK);
    }

    /* Pace: a hairline where the period says you should be, with the 10px disc
       on top. This is the only moon on the scale — it tells time, not money. */
    var paceRatio = Number(r.paceRatio);
    if (isFinite(paceRatio) && paceRatio >= 0) {
      var paceX = xAt(Math.min(paceRatio, 1));
      out += rule(paceX, y - 7, paceX, y + 7, "var(--ink-dim)", W_REF);
      out += discMarkup(paceX, y - 13, 5, paceRatio);
    }

    /* Readout: percent above the band, the drift sentence below it. Both keep
       clear of the spill so the broken alignment stays legible. */
    var readX = w - 4;
    var percentText = opts.percentText;
    if (percentText === undefined || percentText === null || percentText === "") {
      percentText = opts.percentFirst ? "%" + pct : pct + "%";
    }
    out += label(readX, y - 6, percentText, over ? overColor : "var(--ink)", "end", 13);
    if (opts.driftText) {
      out += label(readX, y + 14, clip(opts.driftText, 28), over ? overColor : "var(--ink-dim)", "end");
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
    run("meter", "over320flare", function () {
      return Charts.meter({ spent: 1920000, limit: 600000, pct: 320, paceRatio: 0.9 },
        { title: "T", desc: "D", ariaLabel: "A", overflowMark: "flare", percentText: "%320" });
    });
    run("meter", "junk", function () {
      return Charts.meter({ spent: "x", limit: 600000, pct: null, paceRatio: "y" }, opts);
    });

    run("moonDisc", "zero", function () { return Charts.moonDisc(0, { ariaLabel: "A", title: "T", desc: "D" }); });
    run("moonDisc", "mid", function () { return Charts.moonDisc(0.7, { ariaLabel: "A" }); });
    run("moonDisc", "full", function () { return Charts.moonDisc(1, { ariaLabel: "A" }); });
    run("moonDisc", "outOfRange", function () { return Charts.moonDisc(3.4, { ariaLabel: "A", size: 10 }); });
    run("moonDisc", "negative", function () { return Charts.moonDisc(-2, null); });
    run("moonDisc", "junk", function () { return Charts.moonDisc("x", { size: -5 }); });

    return { ok: failures.length === 0, total: count, failures: failures };
  };

  Moon.Charts = Charts;
})(window);
