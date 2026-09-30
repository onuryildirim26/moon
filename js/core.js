/* Moon — core namespace.
 *
 * First script on the page. Owns window.Moon and the three primitives every
 * other file leans on: util (pure helpers), bus (events), dom (element build).
 * Depends on nothing. Touches no storage, no DOM at load time.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  /* ---------------------------------------------------------------- util */

  var idCounter = 0;

  var ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };

  var util = {
    /* Short, sortable, collision-free within a session: time + counter + noise. */
    id: function (prefix) {
      idCounter += 1;
      var stamp = Date.now().toString(36);
      var seq = idCounter.toString(36);
      var noise = Math.floor(Math.random() * 1296).toString(36);
      return (prefix ? prefix + "_" : "") + stamp + seq + noise;
    },

    esc: function (value) {
      if (value === null || value === undefined) return "";
      return String(value).replace(/[&<>"']/g, function (ch) {
        return ESCAPES[ch];
      });
    },

    clone: function (value) {
      if (typeof global.structuredClone === "function") {
        try {
          return global.structuredClone(value);
        } catch (e) { /* functions or DOM nodes inside: fall through */ }
      }
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    },

    clamp: function (n, min, max) {
      return n < min ? min : (n > max ? max : n);
    },

    debounce: function (fn, ms) {
      var timer = null;
      var wrapped = function () {
        var args = arguments;
        var self = this;
        if (timer) global.clearTimeout(timer);
        timer = global.setTimeout(function () {
          timer = null;
          fn.apply(self, args);
        }, ms);
      };
      wrapped.cancel = function () {
        if (timer) global.clearTimeout(timer);
        timer = null;
      };
      wrapped.flush = function () {
        if (timer) {
          global.clearTimeout(timer);
          timer = null;
          fn.call(this);
        }
      };
      return wrapped;
    },

    /* Stable sort on a copy. keyFn may return a number or a string. */
    sortBy: function (array, keyFn, desc) {
      var decorated = array.map(function (item, index) {
        return { item: item, key: keyFn(item), index: index };
      });
      decorated.sort(function (a, b) {
        if (a.key < b.key) return desc ? 1 : -1;
        if (a.key > b.key) return desc ? -1 : 1;
        return a.index - b.index;
      });
      return decorated.map(function (entry) {
        return entry.item;
      });
    },

    groupBy: function (array, keyFn) {
      var map = new Map();
      array.forEach(function (item) {
        var key = keyFn(item);
        var bucket = map.get(key);
        if (!bucket) {
          bucket = [];
          map.set(key, bucket);
        }
        bucket.push(item);
      });
      return map;
    },

    /* Turkish-aware lowercasing (I -> ı, İ -> i). Search runs both the needle
       and the haystack through this, so one locale for both sides is correct. */
    lower: function (value, locale) {
      if (value === null || value === undefined) return "";
      return String(value).toLocaleLowerCase(locale || "tr");
    },

    /* Search key: lowercase, collapse whitespace, drop punctuation. Used by the
       ledger filter and by the duplicate fingerprint in Model. */
    searchKey: function (value) {
      return util.lower(value).replace(/[^\p{L}\p{N}]+/gu, "");
    },

    pad2: function (n) {
      return (n < 10 ? "0" : "") + n;
    }
  };

  Moon.util = util;

  /* Marks a string as markup that is already escaped, for dom.el({html}). */
  Moon.raw = function (markup) {
    return { __html: markup === null || markup === undefined ? "" : String(markup) };
  };

  /* ----------------------------------------------------------------- bus */

  var listeners = Object.create(null);

  Moon.bus = {
    on: function (event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return function off() {
        Moon.bus.off(event, fn);
      };
    },

    off: function (event, fn) {
      var bucket = listeners[event];
      if (!bucket) return;
      var i = bucket.indexOf(fn);
      if (i !== -1) bucket.splice(i, 1);
    },

    /* One listener throwing must not stop the others or the caller. */
    emit: function (event, payload) {
      var bucket = listeners[event];
      if (!bucket || !bucket.length) return;
      bucket.slice().forEach(function (fn) {
        try {
          fn(payload);
        } catch (e) {
          if (global.console) global.console.error("Moon.bus " + event, e);
        }
      });
    }
  };

  /* ----------------------------------------------------------------- dom */

  function applyAttr(node, key, value) {
    if (value === null || value === undefined || value === false) return;

    if (key === "class" || key === "className") {
      node.setAttribute("class", value);
      return;
    }
    if (key === "text") {
      node.textContent = value;
      return;
    }
    if (key === "html") {
      /* Either Moon.raw(...) or a string the caller already escaped. */
      node.innerHTML = value && value.__html !== undefined ? value.__html : String(value);
      return;
    }
    if (key === "on") {
      Object.keys(value).forEach(function (type) {
        node.addEventListener(type, value[type]);
      });
      return;
    }
    if (key === "dataset") {
      Object.keys(value).forEach(function (name) {
        node.dataset[name] = value[name];
      });
      return;
    }
    if (key === "style" && typeof value === "object") {
      Object.keys(value).forEach(function (prop) {
        node.style.setProperty(prop, value[prop]);
      });
      return;
    }
    if (value === true) {
      node.setAttribute(key, "");
      return;
    }
    node.setAttribute(key, value);
  }

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (one) {
        append(node, one);
      });
      return;
    }
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(global.document.createTextNode(String(child)));
      return;
    }
    node.appendChild(child);
  }

  Moon.dom = {
    el: function (tag, attrs, children) {
      var node = global.document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (key) {
          applyAttr(node, key, attrs[key]);
        });
      }
      if (children !== undefined) append(node, children);
      return node;
    },

    frag: function (children) {
      var fragment = global.document.createDocumentFragment();
      append(fragment, children);
      return fragment;
    },

    clear: function (node) {
      while (node && node.firstChild) node.removeChild(node.firstChild);
      return node;
    },

    /* Turns an SVG markup string from Moon.Charts into a live node. */
    svg: function (markup) {
      var parsed = new global.DOMParser().parseFromString(String(markup), "image/svg+xml");
      var root = parsed.documentElement;
      if (!root || root.nodeName === "parsererror") {
        if (global.console) global.console.error("Moon.dom.svg: bad markup", markup);
        return global.document.createComment("bad svg");
      }
      return global.document.importNode(root, true);
    },

    qs: function (selector, root) {
      return (root || global.document).querySelector(selector);
    },

    qsa: function (selector, root) {
      return Array.prototype.slice.call((root || global.document).querySelectorAll(selector));
    }
  };

  Moon.Lang = Moon.Lang || {};
  Moon.Views = Moon.Views || {};
})(window);
