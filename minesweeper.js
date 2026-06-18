// minesweeper.js — pure game logic + DOM rendering, no eye-tracking here.

export const DIFFICULTIES = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

export class Minesweeper {
  constructor(boardEl, callbacks = {}) {
    this.boardEl = boardEl;
    this.callbacks = callbacks; // { onStateChange, onTick }
    this.cfg = DIFFICULTIES.beginner;
    this.reset(this.cfg);
  }

  reset(cfg = this.cfg) {
    this.cfg = cfg;
    const { rows, cols } = cfg;
    this.rows = rows;
    this.cols = cols;
    this.minesCount = cfg.mines;
    this.firstClick = true;
    this.gameOver = false;
    this.won = false;
    this.flags = 0;
    this.revealedCount = 0;
    this.startTime = null;
    this.elapsed = 0;
    this._stopTimer();

    // grid[r][c] = { mine, revealed, flagged, adj, el }
    this.grid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({
        mine: false, revealed: false, flagged: false, adj: 0, el: null,
      }))
    );

    this._render();
    this._emit();
  }

  _render() {
    const { rows, cols } = this;
    this.boardEl.innerHTML = "";
    this.boardEl.style.gridTemplateColumns = `repeat(${cols}, 34px)`;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const el = document.createElement("div");
        el.className = "cell";
        el.dataset.r = r;
        el.dataset.c = c;
        el.setAttribute("role", "gridcell");
        el.addEventListener("click", (e) => {
          e.preventDefault();
          this.reveal(r, c);
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.toggleFlag(r, c);
        });
        this.grid[r][c].el = el;
        this.boardEl.appendChild(el);
      }
    }
  }

  _inBounds(r, c) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }

  _neighbors(r, c) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        if (this._inBounds(r + dr, c + dc)) out.push([r + dr, c + dc]);
      }
    }
    return out;
  }

  _placeMines(safeR, safeC) {
    const { rows, cols, minesCount } = this;
    // safe zone = clicked cell + neighbors, so first click is always open
    const safe = new Set([`${safeR},${safeC}`]);
    for (const [nr, nc] of this._neighbors(safeR, safeC)) safe.add(`${nr},${nc}`);

    let placed = 0;
    while (placed < minesCount) {
      const r = Math.floor(Math.random() * rows);
      const c = Math.floor(Math.random() * cols);
      if (safe.has(`${r},${c}`) || this.grid[r][c].mine) continue;
      this.grid[r][c].mine = true;
      placed++;
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.grid[r][c].mine) continue;
        this.grid[r][c].adj = this._neighbors(r, c)
          .filter(([nr, nc]) => this.grid[nr][nc].mine).length;
      }
    }
  }

  _startTimer() {
    this.startTime = Date.now();
    this._timer = setInterval(() => {
      this.elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.callbacks.onTick?.(this.elapsed);
    }, 250);
  }
  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  reveal(r, c) {
    if (this.gameOver || !this._inBounds(r, c)) return;
    const cell = this.grid[r][c];
    if (cell.flagged) return;

    if (this.firstClick) {
      this._placeMines(r, c);
      this.firstClick = false;
      this._startTimer();
    }

    // chord: clicking a satisfied number reveals neighbors
    if (cell.revealed) {
      this._chord(r, c);
      return;
    }

    if (cell.mine) {
      this._loseAt(r, c);
      return;
    }

    this._floodReveal(r, c);
    this._checkWin();
    if (!this.gameOver) this.callbacks.onReveal?.();
    this._emit();
  }

  _floodReveal(r, c) {
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const cell = this.grid[cr][cc];
      if (cell.revealed || cell.flagged || cell.mine) continue;
      cell.revealed = true;
      this.revealedCount++;
      this._paint(cr, cc);
      if (cell.adj === 0) {
        for (const [nr, nc] of this._neighbors(cr, cc)) {
          if (!this.grid[nr][nc].revealed) stack.push([nr, nc]);
        }
      }
    }
  }

  _chord(r, c) {
    const cell = this.grid[r][c];
    if (cell.adj === 0) return;
    const neigh = this._neighbors(r, c);
    const flagged = neigh.filter(([nr, nc]) => this.grid[nr][nc].flagged).length;
    if (flagged !== cell.adj) return;
    const before = this.revealedCount;
    for (const [nr, nc] of neigh) {
      const n = this.grid[nr][nc];
      if (!n.flagged && !n.revealed) {
        if (n.mine) { this._loseAt(nr, nc); return; }
        this._floodReveal(nr, nc);
      }
    }
    this._checkWin();
    if (!this.gameOver && this.revealedCount > before) this.callbacks.onReveal?.();
    this._emit();
  }

  toggleFlag(r, c) {
    if (this.gameOver || !this._inBounds(r, c)) return;
    const cell = this.grid[r][c];
    if (cell.revealed) return;
    cell.flagged = !cell.flagged;
    this.flags += cell.flagged ? 1 : -1;
    this._paint(r, c);
    this.callbacks.onFlag?.(cell.flagged);
    this._emit();
  }

  _loseAt(r, c) {
    this.gameOver = true;
    this.won = false;
    this._stopTimer();
    this.grid[r][c].el.classList.add("mine-hit");
    for (let rr = 0; rr < this.rows; rr++) {
      for (let cc = 0; cc < this.cols; cc++) {
        const cell = this.grid[rr][cc];
        if (cell.mine && !(rr === r && cc === c)) {
          cell.el.classList.add("mine-reveal");
          cell.el.textContent = "💣";
        }
        if (cell.flagged && !cell.mine) {
          cell.el.textContent = "❌";
        }
      }
    }
    this._emit();
  }

  _checkWin() {
    const total = this.rows * this.cols;
    if (this.revealedCount === total - this.minesCount) {
      this.gameOver = true;
      this.won = true;
      this._stopTimer();
      // auto-flag remaining mines
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cell = this.grid[r][c];
          if (cell.mine && !cell.flagged) {
            cell.flagged = true;
            this.flags++;
            this._paint(r, c);
          }
        }
      }
    }
  }

  _paint(r, c) {
    const cell = this.grid[r][c];
    const el = cell.el;
    el.className = "cell";
    if (cell.flagged) {
      el.classList.add("flagged");
      el.textContent = "🚩";
    } else if (cell.revealed) {
      el.classList.add("revealed");
      if (cell.adj > 0) {
        el.textContent = cell.adj;
        el.classList.add(`n${cell.adj}`);
      } else {
        el.textContent = "";
      }
    } else {
      el.textContent = "";
    }
  }

  _emit() {
    this.callbacks.onStateChange?.({
      minesRemaining: this.minesCount - this.flags,
      gameOver: this.gameOver,
      won: this.won,
      elapsed: this.elapsed,
    });
  }

  // helper used by eye-tracking layer: which cell is at a screen point?
  cellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (el && el.classList.contains("cell")) {
      return { r: +el.dataset.r, c: +el.dataset.c, el };
    }
    return null;
  }
}
