/* Moon — the Accounts section (#hesaplar; SPEC §5.1, class contract §10).
 *
 * Where the money sits, drawn as a grid of cards: an icon, the name, the kind,
 * the balance, and one line saying what actually moved through the account
 * this period. A balance is the one reading in Moon allowed to be negative — a
 * credit card owes money by nature — and the total above the grid is the sum
 * of the cards under it, which is why an archived account counts in neither.
 *
 * NO DIALOG WRITES ANYTHING HERE. A new account is a Moon.UI.quickRow that
 * stays open: type a name, press Enter, the caret comes back for the next one.
 * The name and the balance on each card are Moon.UI.inlineValue, so correcting
 * either is a click, a few digits and Enter. Nothing an account carries is
 * fixed at birth: the kind, the colour and the icon are corrected in the card's
 * own fold, one quiet toggle away, which is also where archiving and deleting
 * moved to — a card nobody is editing stays exactly as tall as a card. The one
 * dialog in the file stands in front of a delete, because that is the one act
 * whose consequence a reader cannot see before it happens: the account goes,
 * and every entry it carried stays in the ledger and loses only its link.
 *
 * Four rules shape the code below:
 *   - Nothing here writes to Moon.Store. Reads come from Moon.Model and from
 *     one read-only peek at state.entries, documented where it is taken; every
 *     change goes through a Moon.Model call.
 *   - render() runs again on state:change and lang:change, so it clears its
 *     root and rebuilds. Everything that is an answer the reader gave is parked
 *     at module level to outlive that redraw: the sentence a refused write left
 *     behind, where the caret belongs, whether the archived list is open, which
 *     cards have their edit fold open, and the kind the add row carries into
 *     the next account. The pickers a draw built are parked there too, so the
 *     next draw can give their keyboard handlers back.
 *   - Every write replaces the control that made it, so every control that
 *     writes leaves a `data-focus` stamp behind and the next render hands the
 *     focus back to the same figure — the same colour dot, the same box.
 *   - A card is a card. Four rows, two controls, no page.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;
  Moon.Views = Moon.Views || {};

  var dom = Moon.dom;
  var util = Moon.util;

  /* The hash stays Turkish for URL permanence; the label comes from i18n. */
  var ID = "hesaplar";

  /* Moon.UI.inlineValue floors a money control at zero unless it is told
     otherwise, and §3.2 makes an account balance signed on purpose. A floor
     this far down is never reached by a typed figure, which is the point: the
     control stops refusing the minus sign without pretending to a limit. */
  var NO_FLOOR = -Number.MAX_SAFE_INTEGER;

  /* The four kinds, if Moon.Store has not loaded to say so itself. */
  var KINDS = ["cash", "bank", "card", "savings"];

  var BLANK_TOTALS = { total: 0, byKind: {}, count: 0 };
  var BLANK_FLOW = { in: 0, out: 0, count: 0 };

  /* ------------------------------------------------- state that outlives a draw */

  var mounted = null;

  /* A refused write is the only thing this section reports in a band: every
     write that lands reports itself in the one live region instead, and a
     figure that changed under the reader's finger needs no sentence at all. */
  var flash = null;

  /* The stamp the next render looks for to hand the focus back. */
  var pendingFocus = null;

  /* The archived fold is the one piece of state a reader sets by hand here, so
     it has to survive the redraw that every write and every language change
     brings. It is deliberately not written to the store: a fold is remembered
     for this visit, and a view does not write settings. */
  var archivedOpen = false;

  /* What a run of accounts shares. keepOnSubmit holds it within one quick row;
     this holds it across the redraw the save itself causes. */
  var addMemory = { kind: "cash" };

  /* Which cards have their edit fold open, by id. Kind, colour and icon are
     settled once and corrected rarely, so they are not worth the three rows
     they would cost on every card; the fold is what keeps a card that nobody
     is editing one card tall. It is a map rather than a single id because two
     cards sit side by side on a wide screen and closing one because the reader
     opened another would be a surprise nobody asked for. Every write redraws
     this file, so the set has to live out here or the fold would shut under
     the hand that was using it. */
  var editing = Object.create(null);

  /* The swatch and the emoji picker each bind a keyboard handler of their own.
     render() throws the whole screen away, so every picker this draw built is
     kept here and released before the next one — otherwise a reader correcting
     four balances leaves four dead rovers listening on detached nodes. */
  var pickers = [];

  /* ---------------------------------------------------------------- plumbing */

  function log(error, where) {
    if (global.console && global.console.error) {
      global.console.error("Moon.Views.accounts" + (where ? " " + where : ""), error);
    }
  }

  /* Model reads are pure, but one corrupt record must not take the whole
     section down with it. */
  function safe(fn, fallback) {
    try {
      var value = fn();
      return value === undefined ? fallback : value;
    } catch (error) {
      log(error, "read");
      return fallback;
    }
  }

  /* No handler on this screen may take the page down with it either. */
  function guard(fn) {
    return function (a, b) {
      try {
        return fn(a, b);
      } catch (error) {
        log(error, "handler");
        return undefined;
      }
    };
  }

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined || key === "") return "";
    if (I18n && typeof I18n.t === "function") {
      return safe(function () { return I18n.t(key, params); }, String(key));
    }
    return String(key);
  }

  function has(key) {
    var I18n = Moon.I18n;
    if (!key || !I18n || typeof I18n.has !== "function") return false;
    return safe(function () { return !!I18n.has(key); }, false) === true;
  }

  /* The key this file wants if the catalogue can answer it, otherwise the one
     that already carries the nearest true sentence. A label asked for by name
     starts working by itself the day the catalogue grows it, and nothing ever
     reaches the screen as its own key. */
  function keyOf(wanted, fallback) {
    return has(wanted) ? wanted : fallback;
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function settings() {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    return (state && state.settings) || {};
  }

  function currencyCode() {
    return settings().currency || "TRY";
  }

  function intOf(value) {
    var n = typeof value === "number" ? value : Number(value);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function monthStartDay() {
    var day = intOf(settings().monthStartDay);
    return day >= 1 && day <= 28 ? day : 1;
  }

  function storeCap(name, fallback) {
    var store = Moon.Store;
    var value = store ? store[name] : null;
    return typeof value === "number" && value > 0 ? value : fallback;
  }

  function kindList() {
    var store = Moon.Store;
    var rows = store && store.ACCOUNT_KINDS;
    return Array.isArray(rows) && rows.length ? rows : KINDS;
  }

  function money(minor) {
    var Money = Moon.Money;
    var value = intOf(minor);
    if (Money && typeof Money.format === "function") {
      var text = safe(function () {
        return Money.format(value, { currency: currencyCode(), lang: lang(), symbol: true });
      }, null);
      if (text) return String(text);
    }
    return String(value);
  }

  /* The header owns the period selector; this view only reads it, and works
     out a sensible default for the time before app.js has booted. */
  function periodOf() {
    var app = Moon.App;
    if (app && app.period) return app.period;
    var Dates = Moon.Dates;
    if (!Dates || typeof Dates.periodKey !== "function" || typeof Dates.today !== "function") return null;
    return safe(function () { return Dates.periodKey(Dates.today(), monthStartDay()); }, null);
  }

  /* ------------------------------------------------------------------ errors */

  /* Moon.Model answers validateAccount() in its own vocabulary and the
     catalogue carries the same sentence under another name. The table is read
     through I18n.has, so a code the catalogue learns to answer directly — it
     already answers err.nameRequired through its own ALIASES — is used as
     given and this fallback stops applying by itself. */
  var MODEL_ERROR = {
    "err.nameRequired": "err.required"
  };

  function errKey(key) {
    if (!key) return null;
    if (has(key)) return key;
    var mapped = MODEL_ERROR[key];
    if (mapped && has(mapped)) return mapped;
    return "err.unknown";
  }

  /* First sentence wins: this file's own reading of a field is more specific
     than the model's, and both can fire on the same one. */
  function mergeErrors(target, source) {
    Object.keys(source || {}).forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(target, name)) return;
      target[name] = errKey(source[name]);
    });
    return target;
  }

  /* ------------------------------------------------------------- model reads */

  function model() {
    return Moon.Model;
  }

  /* Archived accounts are read too: a reader who closed one has to be able to
     open it again, and a card they cannot see is a card they cannot restore. */
  function allAccounts() {
    var Model = model();
    if (!Model || typeof Model.accounts !== "function") return [];
    var rows = safe(function () { return Model.accounts({ all: true }); }, []);
    return Array.isArray(rows) ? rows : [];
  }

  function totalsOf() {
    var Model = model();
    if (!Model || typeof Model.accountTotals !== "function") return BLANK_TOTALS;
    return safe(function () { return Model.accountTotals(); }, BLANK_TOTALS) || BLANK_TOTALS;
  }

  function balanceOf(id) {
    var Model = model();
    if (!Model || typeof Model.accountBalance !== "function") return 0;
    return intOf(safe(function () { return Model.accountBalance(id); }, 0));
  }

  function flowOf(id) {
    var Model = model();
    if (!Model || typeof Model.accountFlow !== "function") return BLANK_FLOW;
    return safe(function () { return Model.accountFlow(id, periodOf()); }, BLANK_FLOW) || BLANK_FLOW;
  }

  /* A read-only peek at a bucket Moon.Model offers no reader for: entries() can
     be filtered by category, direction and period but not by account, and the
     undo band behind a delete has to know WHICH entries lost their link.
     removeAccount reports how many, and once the account is gone nothing can
     count them again. Nothing in this file writes here. */
  function entryIdsOf(accountId) {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    var rows = state && Array.isArray(state.entries) ? state.entries : [];
    var out = [];
    rows.forEach(function (entry) {
      if (entry && entry.id && entry.accountId === accountId) out.push(entry.id);
    });
    return out;
  }

  /* ------------------------------------------------------------ record reads */

  function nameOf(account) {
    var name = account && account.name ? String(account.name).trim() : "";
    return name || t("common.unclassified");
  }

  function kindOf(account) {
    var kind = account && account.kind ? String(account.kind) : "";
    return kindList().indexOf(kind) === -1 ? kindList()[0] : kind;
  }

  function kindLabel(kind) {
    return t(keyOf("accounts.kind." + kind, "form.kind"));
  }

  function defaultIcon(kind) {
    var store = Moon.Store;
    var byKind = (store && store.ICON_BY_ACCOUNT_KIND) || null;
    var icon = byKind ? byKind[kind] : null;
    return icon || (store && store.FALLBACK_ICON) || "•";
  }

  function iconOf(account) {
    var icon = account && account.icon ? String(account.icon).trim() : "";
    return icon || defaultIcon(kindOf(account));
  }

  /* The store normalises a colour to uppercase #RRGGBB on every read, so this
     only has to catch a record that reached the page another way. A shape
     check rather than a repair: a colour this file cannot read is simply not
     written, and :root's own --tone default paints the card instead.

     What goes on the card is never the stored hex. Dawn deliberately darkens
     all ten spectrum colours so they clear 4.5:1 on white, so a card painted
     from the hex would show a reader on Dawn a different colour from the one
     they picked in the swatch. Moon.UI.tone answers the theme's own token with
     that hex as its fallback, which is also how a colour from outside the ten
     keeps painting exactly as it was written. */
  function hexOf(account) {
    var value = account && account.color ? String(account.color).trim() : "";
    return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
  }

  function toneOf(account) {
    var UI = Moon.UI;
    var hex = hexOf(account);
    if (!hex) return null;
    if (!UI || typeof UI.tone !== "function") return hex;
    return safe(function () { return UI.tone(hex); }, hex) || hex;
  }

  /* ----------------------------------------------------------- focus stamps */

  function focusTag(kind, id) {
    return kind + ":" + (id === null || id === undefined ? "" : String(id));
  }

  function stamp(node, tag) {
    if (node && typeof node.setAttribute === "function") node.setAttribute("data-focus", tag);
    return node;
  }

  function focusIt(node) {
    if (!node || typeof node.focus !== "function") return false;
    try {
      node.focus();
    } catch (error) {
      log(error, "focus");
      return false;
    }
    return true;
  }

  /* Compared rather than selected: an account id is generated text, and
     building a selector out of it would be one escaping bug waiting to
     happen. A stamp this render did not publish — a card that was just
     deleted — simply is not there, and nothing moves. */
  function restoreFocus(root) {
    var want = pendingFocus;
    pendingFocus = null;
    if (!want || !root) return;
    var found = null;
    dom.qsa("[data-focus]", root).forEach(function (candidate) {
      if (!found && candidate.getAttribute("data-focus") === want) found = candidate;
    });
    if (found) focusIt(found);
  }

  /* ------------------------------------------------------------- the screen */

  function repaint() {
    var root = mounted;
    if (!root) return;
    var doc = root.ownerDocument;
    if (doc && doc.contains && !doc.contains(root)) return;
    render(root);
  }

  /* After a save the quick row still on screen finishes its own job — clear
     the written fields, put the caret back — before this view is allowed to
     tear it down and build the next one. A synchronous repaint from inside
     onSubmit would detach the row mid-submit. */
  function queueRepaint() {
    if (!global.setTimeout) {
      repaint();
      return;
    }
    global.setTimeout(function () {
      repaint();
    }, 0);
  }

  /* Only a refused write reaches a band. app.js carries the standing sentence
     for a read-only or full store; this one says that THIS act did not land. */
  function report(key, kind) {
    flash = key ? { key: key, kind: kind || "error" } : null;
    repaint();
  }

  function flashNode() {
    var current = flash;
    var UI = Moon.UI;
    if (!current || !UI || typeof UI.notice !== "function") return null;
    return safe(function () {
      return UI.notice({
        kind: current.kind,
        "class": "is-" + current.kind,
        messageKey: current.key,
        dismissible: true,
        dismissKey: "common.close",
        /* Dismissing removes the node; without this the next redraw brings the
           same sentence back and the close button reads as broken. */
        onDismiss: function () {
          if (flash === current) flash = null;
        }
      });
    }, null);
  }

  /* The one live region (#strip). Every write that lands reports itself here
     rather than in a band on the page: the strip costs the layout nothing and
     it carries the way back with it. */
  function strip(messageKey, params, onUndo) {
    var UI = Moon.UI;
    if (!UI || typeof UI.undoStrip !== "function") return;
    try {
      UI.undoStrip({
        messageKey: messageKey,
        params: params,
        dismissKey: "common.close",
        onUndo: guard(onUndo)
      });
    } catch (error) {
      log(error, "strip");
    }
  }

  function btn(labelKey, onClick, pressed) {
    var node = dom.el("button", {
      type: "button",
      "class": "btn is-quiet",
      text: t(labelKey)
    });
    if (pressed !== undefined) node.setAttribute("aria-pressed", pressed ? "true" : "false");
    node.addEventListener("click", guard(onClick));
    return node;
  }

  /* A picker is asked for rather than assumed: a ui.js without either control
     still has to leave a usable card, and the caller drops a null. */
  function picker(name, spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI[name] !== "function") return null;
    var api = safe(function () { return UI[name](spec); }, null);
    if (api) pickers.push(api);
    return api;
  }

  function releasePickers() {
    var open = pickers;
    pickers = [];
    open.forEach(function (api) {
      if (api && typeof api.destroy === "function") {
        try {
          api.destroy();
        } catch (error) {
          log(error, "picker");
        }
      }
    });
  }

  /* --------------------------------------------------------------- the writes */

  /* One writer for both figures on a card, so correcting a name and correcting
     a balance cannot disagree about what "saved" means. It answers the way
     inlineValue asks: false puts the old reading back and makes the control
     say that nothing was written. */
  function writePatch(account, patch, undo, tag) {
    var Model = model();
    if (!Model || typeof Model.updateAccount !== "function") return false;
    pendingFocus = tag;
    if (!Model.updateAccount(account.id, patch)) {
      pendingFocus = null;
      return false;
    }
    strip("accounts.saved", null, function () {
      Model.updateAccount(account.id, undo);
    });
    return true;
  }

  /* Archiving is one press and it is reversible twice over: the strip offers
     the way straight back, and the card itself is still there in the fold
     wearing the other label. The fold is opened BEFORE the write so the button
     under the reader's finger is still on screen afterwards — the card moves
     from the grid into the fold, and the focus moves with it. */
  function setArchived(account, next) {
    var Model = model();
    if (!Model || typeof Model.updateAccount !== "function") return;
    if (next) archivedOpen = true;
    pendingFocus = focusTag("archive", account.id);
    if (!Model.updateAccount(account.id, { archived: next })) {
      pendingFocus = null;
      report("err.unknown", "error");
      return;
    }
    strip(next ? "accounts.archived" : "accounts.saved", null, function () {
      Model.updateAccount(account.id, { archived: !next });
    });
  }

  /* The undo behind a delete has to put back more than the account: the
     entries that lost their link are pointed at the revived record one by one,
     because addAccount writes a new id and nothing in the store remembers the
     old one. The snapshot is taken BEFORE the removal, while the links are
     still there to read. */
  function doRemove(account) {
    var Model = model();
    if (!Model || typeof Model.removeAccount !== "function") return;

    var snapshot = {
      name: account.name,
      kind: account.kind,
      opening: intOf(account.opening),
      currency: account.currency,
      color: account.color,
      icon: account.icon,
      archived: !!account.archived,
      createdAt: account.createdAt,
      entries: entryIdsOf(account.id)
    };

    /* removeAccount answers { record, detached } rather than an id, because
       accounts.removed tells the reader how many entries are now unattached
       and once the account is gone they cannot count them for themselves. */
    var done = Model.removeAccount(account.id);
    if (!done || !done.record) {
      report("err.unknown", "error");
      return;
    }

    /* The fold belonged to a card that no longer exists, and undo brings the
       account back under a new id, so the old key would sit in the map for the
       rest of the visit answering for nobody. */
    delete editing[account.id];
    pendingFocus = focusTag("add", "");
    repaint();

    strip("accounts.removed", {
      name: nameOf(done.record),
      count: intOf(done.detached)
    }, function () {
      var revived = Model.addAccount(snapshot);
      if (!revived) return;
      snapshot.entries.forEach(function (entryId) {
        Model.updateEntry(entryId, { accountId: revived });
      });
    });
  }

  /* The one question in this file. It is asked because a delete is the only
     act here whose consequence a reader cannot see before it happens, and the
     catalogue's sentence says exactly what removeAccount does: the account
     goes, the entries stay in the ledger and lose only their link. */
  function askRemove(account) {
    var UI = Moon.UI;
    var ask = UI && typeof UI.confirm === "function"
      ? safe(function () {
        return UI.confirm({
          titleKey: "accounts.delete.title",
          bodyKey: "accounts.delete.body",
          confirmKey: "common.delete",
          cancelKey: "common.cancel",
          danger: true
        });
      }, null)
      : null;

    /* Without the dialog there is nobody to ask and the reader has already
       pressed Delete, so the press is the answer. */
    if (!ask || typeof ask.then !== "function") {
      doRemove(account);
      return;
    }
    ask.then(guard(function (yes) {
      if (yes) doRemove(account);
    }));
  }

  /* -------------------------------------------------------------- the card */

  /* moon.css aligns an inlineValue to the right, which is the only sane place
     for a figure and the wrong one for a name. */
  function leftAlign(element) {
    dom.qsa(".inlinevalue__btn, .inlinevalue__input", element).forEach(function (half) {
      if (half.style && typeof half.style.setProperty === "function") {
        half.style.setProperty("text-align", "left");
      }
    });
    return element;
  }

  function nameCell(account) {
    var UI = Moon.UI;
    var tag = focusTag("name", account.id);
    if (!UI || typeof UI.inlineValue !== "function") {
      return dom.el("span", { "class": "account__name", title: nameOf(account), text: nameOf(account) });
    }

    var api = safe(function () {
      return UI.inlineValue({
        /* The contract class goes on the control itself rather than on a
           wrapper around it: moon.css places every part of this card by
           explicit grid area, and an area does not reach a part nested one
           level deeper than the contract says it is. */
        "class": "account__name",
        value: nameOf(account),
        type: "text",
        maxLength: storeCap("ACCOUNT_NAME_MAX", 60),
        /* The name a card is told apart by belongs in the control's accessible
           name, which is what accounts.name.edit is asked for here. Until the
           catalogue carries it the plain label stands, and the reader hears
           what the control is rather than nothing at all. */
        labelKey: keyOf("accounts.name.edit", "accounts.name"),
        labelParams: function (value) {
          return { name: value === null || value === undefined ? "" : String(value) };
        },
        onSave: function (value) {
          var name = String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "");
          /* An account with no name cannot be told from another nameless one,
             so an emptied name is the one text this control refuses. */
          if (!name) return false;
          if (name === account.name) return true;
          return writePatch(account, { name: name }, { name: account.name }, tag);
        }
      });
    }, null);
    if (!api) {
      return dom.el("span", { "class": "account__name", title: nameOf(account), text: nameOf(account) });
    }

    stamp(dom.qs(".inlinevalue__btn", api.element), tag);
    return leftAlign(api.element);
  }

  /* The card shows the BALANCE, and §3.2 stores the opening: the balance is
     the opening plus everything the ledger moved through the account. So the
     figure a reader corrects here is written back by moving the OPENING by the
     difference — what they typed becomes the balance they are looking at, and
     not one entry is touched. Correcting the reading against a bank statement
     is the whole reason this control exists. */
  function valueCell(account) {
    var UI = Moon.UI;
    var tag = focusTag("value", account.id);
    var opening = intOf(account.opening);
    var balance = balanceOf(account.id);
    var moved = balance - opening;

    if (!UI || typeof UI.inlineValue !== "function") {
      return dom.el("span", { "class": "tnum", text: money(balance) });
    }

    var api = safe(function () {
      return UI.inlineValue({
        value: balance,
        type: "money",
        currency: currencyCode(),
        min: NO_FLOOR,
        labelKey: keyOf("accounts.balance.edit", "accounts.balance"),
        labelParams: function (value) {
          return { amount: money(value) };
        },
        onSave: function (next) {
          /* An emptied box has no honest reading. A balance is not zero
             because the field is blank, so the old figure comes back. */
          if (typeof next !== "number" || !isFinite(next)) return false;
          var wanted = Math.round(next) - moved;
          if (wanted === opening) return true;
          return writePatch(account, { opening: wanted }, { opening: opening }, tag);
        }
      });
    }, null);
    if (!api) return dom.el("span", { "class": "tnum", text: money(balance) });

    stamp(dom.qs(".inlinevalue__btn", api.element), tag);
    return api.element;
  }

  /* The pill IS the cell: moon.css places this row and asks for a .tag in it,
     and a wrapper around one pill would be a node that says nothing. The dot
     comes from the card's own --tone, so the row says whose account this is
     before a word of it is read. */
  function kindCell(account) {
    return dom.el("span", {
      "class": "tag account__kind",
      text: kindLabel(kindOf(account))
    });
  }

  /* The balance and the one way into the rest of the card share the card's one
     full-width row. The contract leaves no slot of its own for an action, so
     the toggle rides with the figure rather than beside the kind pill:
     measured against the pill, a column narrower than a phone's — 236px at a
     520px viewport, 275px at 1200px — wrapped it onto a second line and made
     the card a third taller for no extra word.

     Only ONE control rides here. At 375px the row is 310px and the balance
     control takes 131px of it, so a third button put the pair on a second line
     and cost the card 36px of height on every card in the grid — which is the
     opposite of what a fold is for. Archive and Delete moved into the fold
     with the rest of the card's management.

     No pill saying "archived" either. The fold around a put-away card carries
     that word, the dashed edge says it in a form that survives a monochrome
     printer, and the button inside says Unarchive. */
  function valueRow(account, open) {
    var row = dom.el("div", { "class": "account__value form__actions" }, [
      valueCell(account)
    ]);

    var toggle = btn("common.edit", function () {
      setEditing(account, !open);
    });
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    /* Only while the panel exists: aria-controls pointing at an id that is not
       in the document is a promise the page cannot keep. */
    if (open) toggle.setAttribute("aria-controls", foldId(account));
    stamp(toggle, focusTag("edit", account.id));
    row.appendChild(toggle);
    return row;
  }

  /* ------------------------------------------------------------- the fold */

  function foldId(account) {
    return "account-edit-" + account.id;
  }

  /* The fold is this view's own answer and nothing in the store moved, so it
     repaints itself rather than waiting for a state:change that is not coming.
     The toggle carries a stamp, so the focus comes back to the control the
     reader pressed whichever way the fold went. */
  function setEditing(account, open) {
    if (open) editing[account.id] = true;
    else delete editing[account.id];
    pendingFocus = focusTag("edit", account.id);
    repaint();
  }

  /* One writer for the three settled fields, so picking a colour and picking an
     icon cannot disagree about what a save means. The fold stays open across
     the redraw the write causes, because `editing` outlives render(). */
  function setField(account, patch, undo, tag) {
    if (writePatch(account, patch, undo, tag)) return;
    /* The dot or the select that asked for this is still handling its own
       event, so the band that says the write was refused waits for a tick
       rather than tearing that control out from under it. */
    flash = { key: "err.unknown", kind: "error" };
    queueRepaint();
  }

  function foldKind(account) {
    var UI = Moon.UI;
    if (!UI || typeof UI.field !== "function") return null;
    var current = kindOf(account);
    var node = safe(function () {
      return UI.field({
        type: "select",
        name: "kind",
        labelKey: "form.kind",
        value: current,
        options: kindOptions(),
        onChange: function (value) {
          if (!value || value === current) return;
          setField(account, { kind: value }, { kind: current }, focusTag("kind", account.id));
        }
      });
    }, null);
    if (!node) return null;
    stamp(node.moonField ? node.moonField.control : null, focusTag("kind", account.id));
    return node;
  }

  /* A picked colour is written the moment it is picked. An Apply button here
     would make the fold a form, and §5.1 says this screen has none — the undo
     strip every write raises is the way back. */
  function foldColor(account) {
    var current = hexOf(account);
    var api = picker("swatch", {
      labelKey: "form.color",
      value: current,
      onPick: function (value) {
        if (!value || value === current) return;
        setField(account, { color: value }, { color: account.color }, focusTag("color", account.id));
      }
    });
    if (!api) return null;

    /* The dot the reader will land on after the write is the one the record
       now wears, and pickGroup gives the dots and their values in the same
       order — so the stamp goes on the dot rather than on the group, which is
       a <div> and takes no focus. */
    var dots = api.dots || [];
    var colors = typeof api.colors === "function" ? safe(function () { return api.colors(); }, []) : [];
    var at = current ? colors.indexOf(current) : -1;
    if (at !== -1 && dots[at]) stamp(dots[at], focusTag("color", account.id));
    return api.element;
  }

  function foldIcon(account) {
    var api = picker("emojiPicker", {
      name: "icon",
      labelKey: "form.icon",
      value: iconOf(account),
      onPick: function (value) {
        if (!value || value === account.icon) return;
        setField(account, { icon: value }, { icon: account.icon }, focusTag("icon", account.id));
      }
    });
    if (!api) return null;
    stamp(api.control, focusTag("icon", account.id));
    return api.element;
  }

  function foldActions(account, archived) {
    var archive = btn(archived ? "accounts.unarchive" : "accounts.archive", function () {
      setArchived(account, !archived);
    }, archived);
    stamp(archive, focusTag("archive", account.id));

    return dom.el("div", { "class": "form__actions" }, [
      archive,
      btn("common.delete", function () {
        askRemove(account);
      })
    ]);
  }

  function editFold(account, archived) {
    var fold = dom.el("div", {
      id: foldId(account),
      /* .account is a grid and the stylesheet names every one of its areas by
         class, so a child it has never heard of is auto-placed into the first
         free cell — column one of a new row, 36 pixels wide. Spanning both
         columns is the one thing about this panel the card's own CSS cannot be
         expected to say, and the stack inside it is the panel's own business.
         Nothing here paints. */
      style: {
        "grid-column": "1 / -1",
        display: "grid",
        "row-gap": "var(--s1)"
      }
    }, [
      foldKind(account),
      foldColor(account),
      foldIcon(account),
      foldActions(account, archived)
    ]);
    return fold;
  }

  /* What a balance alone cannot say: whether anything is actually running
     through the account. A period with nothing in it gets its own sentence
     rather than a pair of zeros dressed up as a measurement. */
  function flowCell(account) {
    var flow = flowOf(account.id);
    var text = intOf(flow.count) > 0
      ? t("accounts.flow", { in: money(flow.in), out: money(flow.out) })
      : t("accounts.flow.none");
    return dom.el("p", { "class": "account__flow", text: text });
  }

  function card(account, archived) {
    var tone = toneOf(account);
    var open = editing[account.id] === true;
    return dom.el("li", {
      "class": "account" + (archived ? " is-archived" : ""),
      /* §10: a record's colour reaches the page as one inline custom property
         and every rule in the stylesheet reads var(--tone) back, so there is
         never a class per colour. A record with no colour of its own inherits
         Moon's accent from :root instead. */
      style: tone ? { "--tone": tone } : null
    }, [
      dom.el("span", { "class": "account__icon", "aria-hidden": "true" }, iconOf(account)),
      nameCell(account),
      kindCell(account),
      valueRow(account, open),
      flowCell(account),
      /* Closed means NOT IN THE DOM rather than merely hidden: a grid of six
         accounts would otherwise carry six selects, sixty colour dots and six
         icon folds nobody has asked to see, and every one of them a tab stop. */
      open ? editFold(account, archived) : null
    ]);
  }

  /* Name order, in the reader's own locale. A list of identities is read by
     looking for one of them, not by comparing their sizes — the comparison is
     what the total above the grid is for. */
  function order(rows) {
    return util.sortBy(rows, function (account) {
      return util.lower(nameOf(account), lang());
    });
  }

  /* A real list, with role=list spelled out because .accounts is display:grid
     and a grid container loses its list semantics in some browsers — how many
     accounts there are is worth hearing before the first one is read.

     No roving tabindex. Every card carries four controls of its own and each
     of them is a real button, so a card is not a row-button the way a ledger
     row is; making it one would add a tab stop that does nothing and still
     leave the controls inside it in the tab order. moon.css says the same
     thing by giving .holding a focus ring and .account none. */
  function grid(rows, archived) {
    var list = dom.el("ul", { "class": "accounts", role: "list" });
    rows.forEach(function (account) {
      if (account && account.id) list.appendChild(card(account, archived));
    });
    return list;
  }

  /* Closed accounts fold away behind one line. They are out of every total by
     the model's own rule, so leaving them in the grid would put the sum above
     it in visible disagreement with the cards under it. */
  function archivedFold(rows) {
    var box = dom.el("details", { "class": "numbers", open: archivedOpen ? true : null });
    var summary = dom.el("summary", null, t("accounts.archived"));
    stamp(summary, focusTag("archived", ""));
    box.appendChild(summary);
    box.addEventListener("toggle", guard(function () {
      archivedOpen = !!box.open;
    }));
    box.appendChild(grid(rows, true));
    return box;
  }

  /* ------------------------------------------------------------- the total */

  /* The sum of the cards below, and how many were counted. The catalogue has
     no sentence for a count of accounts, so the figure rides in the shape this
     app already uses for "this collection, this many" — a translated word and
     a bare numeral in a pill, exactly as the restore summary prints its
     counts. Both halves sit on one line, because a total and its count are
     one reading. */
  function totalRow(totals) {
    return dom.el("div", { "class": "form__actions" }, [
      dom.el("p", { "class": "mid", text: t("accounts.total", { amount: money(totals.total) }) }),
      dom.el("span", { "class": "tag" }, [
        dom.el("span", { text: t("nav.accounts") }),
        dom.el("span", { "class": "tnum", text: String(intOf(totals.count)) })
      ])
    ]);
  }

  /* ----------------------------------------------------------- the add row */

  function kindOptions() {
    return kindList().map(function (kind) {
      return { value: kind, labelKey: keyOf("accounts.kind." + kind, "form.kind") };
    });
  }

  /* One line, always open, Enter writes. The colour and the icon live in the
     folded half: the model deals an unpicked account a spectrum colour by
     position and the glyph of its own kind, so neither is a decision a reader
     has to make, and ten 40px dots standing open on a phone would cost more
     screen than the three figures that matter. */
  function addRow() {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.quickRow !== "function" || !Model) return null;

    var kinds = kindList();
    var kind = kinds.indexOf(addMemory.kind) === -1 ? kinds[0] : addMemory.kind;

    /* Neither control is a UI.field, so neither appears in quickRow's values()
       and both are read from here. That is also why they are not cleared by
       the row's own keepOnSubmit: the redraw a save brings builds them again. */
    var color = null;
    var icon = defaultIcon(kind);
    var iconTouched = false;

    /* Asked for rather than assumed: a ui.js without either control still has
       to leave a usable add row, and quickRow drops a falsy field by itself. */
    var swatch = picker("swatch", {
      onPick: function (value) {
        color = value;
      }
    });

    var icons = picker("emojiPicker", {
      value: icon,
      onPick: function (value) {
        icon = value;
        iconTouched = true;
      }
    });

    var kindField = UI.field({
      type: "select",
      name: "kind",
      labelKey: "form.kind",
      value: kind,
      options: kindOptions(),
      onChange: function (value) {
        /* The glyph follows the kind until the reader picks one of their own:
           a bank account that arrives already wearing the bank icon is one
           less decision, and overwriting a chosen icon would be rude. */
        if (iconTouched) return;
        icon = defaultIcon(value);
        if (icons) icons.set(icon);
      }
    });

    var api = safe(function () {
      return UI.quickRow({
        id: "accounts-add",
        memoryKey: "accounts.add",
        submitLabelKey: "common.add",
        moreLabelKey: "common.more",
        keepOnSubmit: ["kind"],
        fields: [
          UI.field({
            type: "text",
            name: "name",
            labelKey: "accounts.name",
            required: true,
            maxLength: storeCap("ACCOUNT_NAME_MAX", 60)
          }),
          kindField,
          UI.field({
            type: "money",
            name: "opening",
            labelKey: "accounts.opening",
            hintKey: "accounts.opening.hint",
            currency: currencyCode(),
            value: ""
          })
        ],
        moreFields: [swatch ? swatch.element : null, icons ? icons.element : null],
        onSubmit: function (values) {
          var errors = {};
          var name = String(values.name || "").replace(/^\s+|\s+$/g, "");
          if (!name) errors.name = errKey("err.nameRequired");

          /* The money field has already refused anything unreadable, so null
             here can only be an empty box — and §3.2 makes the opening
             optional, because most accounts are written down mid-month with
             whatever happens to be in them. */
          var draft = {
            name: name,
            kind: values.kind,
            opening: typeof values.opening === "number" ? values.opening : 0,
            currency: currencyCode(),
            color: color,
            icon: icon
          };

          if (typeof Model.validateAccount === "function") {
            var check = Model.validateAccount(draft);
            if (check && !check.ok) mergeErrors(errors, check.errors);
          }
          if (Object.keys(errors).length) return { ok: false, errors: errors };

          var written = Model.addAccount(draft);
          /* The store refused the write (read-only, quota). app.js carries the
             standing band for that; this row only has to keep the typed line
             and say that nothing was written. */
          if (!written) return { ok: false, errors: { name: "err.unknown" } };

          /* The kind carries over because a reader writing down their accounts
             usually writes two cards or two bank accounts in a row. The colour
             and the icon deliberately do not: the model deals the next one a
             different colour by position, so a run of accounts comes out
             distinguishable without anybody choosing anything. */
          addMemory = { kind: draft.kind };
          pendingFocus = focusTag("add", "");
          queueRepaint();
          return null;
        }
      });
    }, null);
    if (!api) return null;

    var first = api.fields ? api.fields.name : null;
    if (first && first.control) stamp(first.control, focusTag("add", ""));
    return api;
  }

  /* The quick row above the grid is the call to action, so the empty state
     says what the section is for and points at that row rather than opening
     anything of its own. */
  function emptyBlock(add) {
    var UI = Moon.UI;
    if (!UI || typeof UI.emptyState !== "function") return null;
    return safe(function () {
      return UI.emptyState({
        headingKey: "accounts.empty.heading",
        bodyKey: "accounts.empty.body",
        actions: [{
          labelKey: "accounts.empty.action",
          onClick: function () {
            if (add && typeof add.focusFirst === "function") add.focusFirst();
          }
        }]
      });
    }, null);
  }

  /* ---------------------------------------------------------------- render */

  /* What has moved between the reader's own accounts. A transfer changes two
     balances and appears in no ledger, because it is neither spending nor
     earning — so without this it would be money that moved with nothing on any
     screen saying so, and the only honest place to show it is beside the
     balances it moved. Drawn only when there is something to draw. */
  function movesBlock() {
    var Model = model();
    if (!Model || typeof Model.transfers !== "function") return null;

    var rows = safe(function () { return Model.transfers(); }, []) || [];
    if (!rows.length) return null;

    var UI = Moon.UI;
    var lines = rows.slice(0, 12).map(function (move) {
      var from = safe(function () { return Model.accountById(move.fromAccountId); }, null);
      var to = safe(function () { return Model.accountById(move.toAccountId); }, null);

      var said = dom.el("span", { "class": "move__what" }, t("accounts.move.line", {
        amount: money(move.amount),
        from: from ? from.name : t("common.unclassified"),
        to: to ? to.name : t("common.unclassified")
      }));

      var when = dom.el("span", { "class": "move__when" },
        safe(function () { return Moon.Dates.formatDate(move.date, lang(), "short"); }, move.date));

      var drop = dom.el("button", { "class": "btn is-quiet move__drop", type: "button" },
        t("common.delete"));
      drop.addEventListener("click", function () {
        var removed = safe(function () { return Model.removeTransfer(move.id); }, null);
        if (!removed) return;
        if (UI && typeof UI.undoStrip === "function") {
          safe(function () {
            UI.undoStrip({
              message: t("accounts.move.removed"),
              onUndo: function () {
                safe(function () { Model.addTransfer(removed); });
              }
            });
          });
        }
      }, false);

      return dom.el("li", { "class": "move" }, [when, said, drop]);
    });

    return dom.el("div", { "class": "moves" }, [
      dom.el("h3", { "class": "moves__title" }, t("accounts.move.title")),
      dom.el("ul", { "class": "moves__list" }, lines)
    ]);
  }

  function render(root) {
    if (!root || !dom) return;
    mounted = root;
    releasePickers();
    dom.clear(root);

    var UI = Moon.UI;
    if (!UI || typeof UI.section !== "function" || !model()) return;

    var note = flashNode();
    if (note) root.appendChild(note);

    var all = allAccounts();
    var live = order(all.filter(function (account) {
      return account && !account.archived;
    }));
    var put = order(all.filter(function (account) {
      return account && account.archived;
    }));

    var add = addRow();
    var body = [];

    /* Reading order, and the quick row is last in both states so it does not
       move when the first account lands. A reader opens this screen to see
       what they have: at 375px the add row is four wrapped lines, and above
       the cards it would push every balance off the first screen. No accounts
       at all means nothing has been measured, and a measured zero is not the
       same number as an unmeasured one (§4), so the total arrives with the
       first card rather than printing ₺0.00 over an empty grid. */
    if (live.length) body.push(totalRow(totalsOf()));
    if (!all.length) body.push(emptyBlock(add));
    if (live.length) body.push(grid(live, false));
    if (put.length) body.push(archivedFold(put));
    var moves = movesBlock();
    if (moves) body.push(moves);
    if (add) body.push(add.element);

    root.appendChild(UI.section({
      id: "accounts",
      titleKey: "accounts.title",
      body: body
    }));

    /* Every write replaced the control that made it. This is the whole of the
       keyboard contract on this screen: correct a balance, press Enter, and
       the caret is back on the same figure. */
    restoreFocus(root);
  }

  /* --------------------------------------------------------------- exports */

  Moon.Views.accounts = {
    id: ID,
    titleKey: "nav.accounts",
    render: function (root) {
      try {
        render(root);
      } catch (error) {
        log(error, "render");
      }
    },
    destroy: function () {
      /* The cached root goes: redrawing into a root the router has handed to
         another view would paint this section over it. Both folds go shut —
         the archived list and every card's edit panel were opened for an
         errand that ended when the reader walked away — and the pickers give
         their keyboard handlers back. The undo offer in #strip is deliberately
         left standing, because its handler calls Moon.Model and keeps working
         from anywhere. */
      releasePickers();
      mounted = null;
      flash = null;
      pendingFocus = null;
      archivedOpen = false;
      editing = Object.create(null);
    }
  };
})(window);
