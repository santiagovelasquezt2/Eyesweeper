import assert from "node:assert/strict";
import test from "node:test";
import { Minesweeper, DIFFICULTIES } from "../src/game/minesweeper.js";

class FakeStyle {
  constructor() {
    this.props = new Map();
  }
  setProperty(name, value) {
    this.props.set(name, String(value));
  }
  getPropertyValue(name) {
    return this.props.get(name) || "";
  }
}

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }
  add(...names) {
    names.forEach((name) => this.classes.add(name));
    this._sync();
  }
  remove(...names) {
    names.forEach((name) => this.classes.delete(name));
    this._sync();
  }
  contains(name) {
    return this.classes.has(name);
  }
  setFromString(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    this._sync();
  }
  _sync() {
    this.el._className = [...this.classes].join(" ");
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this.clientWidth = 640;
    this.textContent = "";
    this._className = "";
  }
  set className(value) {
    this.classList.setFromString(value);
  }
  get className() {
    return this._className;
  }
  set innerHTML(value) {
    this.children = [];
    this._innerHTML = value;
  }
  get innerHTML() {
    return this._innerHTML || "";
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains?.(node));
  }
  closest(selector) {
    if (selector === ".cell" && this.classList.contains("cell")) return this;
    return this.parentElement?.closest?.(selector) || null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientWidth };
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
};
globalThis.window = { innerWidth: 1024 };
globalThis.getComputedStyle = (el) => ({
  getPropertyValue: (name) => el.style.getPropertyValue(name),
});

function makeBoard(width = 640) {
  const panel = new FakeElement("section");
  panel.clientWidth = width;
  const board = new FakeElement("div");
  board.parentElement = panel;
  return board;
}

test("reset emits a zero timer value", () => {
  const ticks = [];
  const game = new Minesweeper(makeBoard(), {
    onTick: (elapsed) => ticks.push(elapsed),
  });

  game.reset(DIFFICULTIES.intermediate);

  assert.deepEqual(ticks, [0, 0]);
});

test("first reveal keeps the clicked cell and its neighbors mine-free", () => {
  const game = new Minesweeper(makeBoard());

  game.reveal(4, 4);

  const safeCells = [[4, 4], ...game._neighbors(4, 4)];
  assert.equal(game.grid.flat().filter((cell) => cell.mine).length, DIFFICULTIES.beginner.mines);
  for (const [r, c] of safeCells) {
    assert.equal(game.grid[r][c].mine, false);
  }
  game._stopTimer();
});

test("cell aria labels follow hidden and flagged state", () => {
  const game = new Minesweeper(makeBoard());
  const cell = game.grid[0][0].el;

  assert.equal(cell.attributes["aria-label"], "Row 1, column 1, hidden");
  game.toggleFlag(0, 0);
  assert.equal(cell.attributes["aria-label"], "Row 1, column 1, flagged");
  game.toggleFlag(0, 0);
  assert.equal(cell.attributes["aria-label"], "Row 1, column 1, hidden");
});

test("losing updates elapsed time before emitting final state", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const states = [];
  const ticks = [];

  try {
    const game = new Minesweeper(makeBoard(), {
      onStateChange: (state) => states.push(state),
      onTick: (elapsed) => ticks.push(elapsed),
    });

    game.reveal(0, 0);
    now = 4200;
    const mine = game.grid.flatMap((row, r) =>
      row.map((cell, c) => ({ cell, r, c }))
    ).find(({ cell }) => cell.mine);
    game.reveal(mine.r, mine.c);

    assert.equal(ticks.at(-1), 3);
    assert.equal(states.at(-1).gameOver, true);
    assert.equal(states.at(-1).elapsed, 3);
  } finally {
    Date.now = originalNow;
  }
});
