/* README: "Money is always an integer number of minor units. Never a float." */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");

const { Money } = load().Moon;

test("the float trap the README describes is real", () => {
  assert.notEqual(19.99 * 100, 1999);
  let floatSum = 0;
  for (let i = 0; i < 100; i += 1) floatSum += 19.99;
  assert.notEqual(floatSum, 1999);
});

test("parsing works on the string, so 19.99 is exactly 1999 minor units", () => {
  assert.equal(Money.parse("19.99").minor, 1999);
  assert.equal(Money.parse("19,99").minor, 1999);
});

test("a hundred subscriptions sum to the exact integer", () => {
  const one = Money.parse("19.99").minor;
  const list = Array.from({ length: 100 }, () => one);
  assert.equal(Money.add(list), 199900);
});

test("Turkish and English statement shapes read the same amount", () => {
  assert.equal(Money.parse("1.234,56").minor, 123456);
  assert.equal(Money.parse("1,234.56").minor, 123456);
  assert.equal(Money.parse("1.234.567,89").minor, 123456789);
  assert.equal(Money.parse("1,234,567.89").minor, 123456789);
  assert.equal(Money.parse("₺1.234,56").minor, 123456);
  assert.equal(Money.parse("1.234,56 TL").minor, 123456);
});

test("negatives in the forms banks export", () => {
  assert.equal(Money.parse("-14.000,00").minor, -1400000);
  assert.equal(Money.parse("(1.234,56)").minor, -123456);
  assert.equal(Money.parse("1.234,56-").minor, -123456);
  assert.equal(Money.parse("−5,00").minor, -500);
});

test("junk is rejected instead of becoming a number", () => {
  for (const bad of ["", "abc", "1.2.3", "--5", "999999999999999999"]) {
    assert.equal(Money.parse(bad).ok, false, JSON.stringify(bad));
  }
});

test("every amount that comes out is an integer", () => {
  const inputs = ["0,01", "19.99", "1.2367", "1,999", "99,999.99", "(0,05)"];
  for (const s of inputs) {
    const r = Money.parse(s);
    assert.ok(Number.isInteger(r.minor), `${s} -> ${r.minor}`);
  }
});

test("formatting round-trips through parse", () => {
  const cases = [0, 5, 1999, 123456, -1990, 123456789];
  for (const minor of cases) {
    for (const lang of ["tr", "en"]) {
      const text = Money.format(minor, { lang, symbol: false });
      assert.equal(Money.parse(text, { decimal: lang === "tr" ? "," : "." }).minor, minor, `${lang} ${text}`);
    }
  }
});
