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
    this._geo = null;
    this._geoDirty = true;
    this._cellSize = 32;
    this._delegated = false;
    this._installDelegation();
    this.reset(this.cfg);
  }

  _installDelegation() {
    if (this._delegated || !this.boardEl) return;
    this._delegated = true;
    this.boardEl.addEventListener("click", (e) => {
      e.preventDefault();
      const cell = this._cellFromEvent(e);
      if (cell) this.reveal(cell.r, cell.c);
    });
    this.boardEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const cell = this._cellFromEvent(e);
      if (cell) this.toggleFlag(cell.r, cell.c);
    });
  }

  _cellFromEvent(e) {
    const el = e.target?.closest?.(".cell");
    if (!el || !this.boardEl.contains(el)) return null;
    const r = +el.dataset.r;
    const c = +el.dataset.c;
    if (!this._inBounds(r, c)) return null;
    return { r, c };
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
	    this.callbacks.onTick?.(0);

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
	    const cellSize = this._recomputeCellSize();
	    this.boardEl.innerHTML = "";
	    this.boardEl.style.setProperty("--cols", String(cols));
	    this.boardEl.style.setProperty("--cell-size", cellSize + "px");
	    this.boardEl.setAttribute("aria-rowcount", String(rows));
	    this.boardEl.setAttribute("aria-colcount", String(cols));
    const frag = typeof document.createDocumentFragment === "function"
      ? document.createDocumentFragment()
      : null;
    const parent = frag || this.boardEl;
	    for (let r = 0; r < rows; r++) {
	      for (let c = 0; c < cols; c++) {
	        const el = document.createElement("div");
	        el.className = "cell";
	        el.dataset.r = r;
	        el.dataset.c = c;
	        el.setAttribute("role", "gridcell");
	        el.setAttribute("aria-rowindex", String(r + 1));
	        el.setAttribute("aria-colindex", String(c + 1));
	        el.setAttribute("aria-label", this._cellLabel(r, c));
	        this.grid[r][c].el = el;
	        parent.appendChild(el);
	      }
    }
    if (frag) this.boardEl.appendChild(frag);
    this.invalidateGeometry();
  }

  _computeCellSize() {
    const cols = this.cols;
    const rows = this.rows;
    const pad = 20; // board inner padding + border slack on each axis
    let availW;
    let availH;
    if (!this.boardEl || !this.boardEl.parentElement) {
      availW = window.innerWidth - 40;
      availH = window.innerHeight - 40;
    } else {
      const parent = this.boardEl.parentElement;
      availW = parent.clientWidth;
      availH = parent.clientHeight || (window.innerHeight - 40);
    }
    const size = Math.floor(
      Math.min((availW - pad) / cols, (availH - pad) / rows)
    );
    return Math.max(22, Math.min(96, size));
  }

  _recomputeCellSize() {
    if (!this.boardEl) return 32;
    const cellSize = this._computeCellSize();
    this._cellSize = cellSize;
    this.boardEl.style.setProperty("--cols", String(this.cols));
    this.boardEl.style.setProperty("--cell-size", cellSize + "px");
    return cellSize;
  }

  invalidateGeometry() {
    this._geo = null;
    this._geoDirty = true;
    if (this.boardEl) this._recomputeCellSize();
  }

  getGeometry() {
    if (!this._geoDirty && this._geo) return this._geo;
    const rect = this.boardEl.getBoundingClientRect();
    const cellSize = this._cellSize || 32;
    const originX = rect.left + 8;
    const originY = rect.top + 8;
    this._geo = {
      left: originX,
      top: originY,
      width: rect.width,
      height: rect.height,
      cellW: cellSize,
      cellH: cellSize,
      rows: this.rows,
      cols: this.cols,
    };
    this._geoDirty = false;
    return this._geo;
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
	    this._stopTimer();
	    this.startTime = Date.now();
	    this.elapsed = 0;
	    this.callbacks.onTick?.(0);
	    this._timer = setInterval(() => {
	      this._updateElapsed();
	    }, 250);
	  }
	  _updateElapsed() {
	    if (this.startTime == null) return;
	    this.elapsed = Math.floor((Date.now() - this.startTime) / 1000);
	    this.callbacks.onTick?.(this.elapsed);
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
    const painted = [];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const cell = this.grid[cr][cc];
      if (cell.revealed || cell.flagged || cell.mine) continue;
      cell.revealed = true;
      this.revealedCount++;
      painted.push([cr, cc]);
      if (cell.adj === 0) {
        for (const [nr, nc] of this._neighbors(cr, cc)) {
          if (!this.grid[nr][nc].revealed) stack.push([nr, nc]);
        }
      }
    }
    this._paintBatch(painted);
  }

  _paintBatch(cells) {
    for (const [r, c] of cells) this._paint(r, c);
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
	    this._updateElapsed();
	    this._stopTimer();
    this.grid[r][c].el.classList.add("mine-hit");
    for (let rr = 0; rr < this.rows; rr++) {
      for (let cc = 0; cc < this.cols; cc++) {
        const cell = this.grid[rr][cc];
	        if (cell.mine && !(rr === r && cc === c)) {
	          cell.el.classList.add("mine-reveal");
	          cell.el.textContent = "";
	        }
	        if (cell.flagged && !cell.mine) {
	          cell.el.classList.add("wrong-flag");
	          cell.el.textContent = "";
	        }
	        this._paintA11y(rr, cc);
	      }
	    }
	    this._emit();
	  }

  _checkWin() {
    const total = this.rows * this.cols;
	    if (this.revealedCount === total - this.minesCount) {
	      this.gameOver = true;
	      this.won = true;
	      this._updateElapsed();
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
      el.textContent = "";
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
	    this._paintA11y(r, c);
	  }

	  _paintA11y(r, c) {
	    this.grid[r][c].el.setAttribute("aria-label", this._cellLabel(r, c));
	  }

	  _cellLabel(r, c) {
	    const cell = this.grid[r][c];
	    const pos = `Row ${r + 1}, column ${c + 1}`;
	    if (this.gameOver && cell.mine) return `${pos}, mine`;
	    if (this.gameOver && cell.flagged && !cell.mine) return `${pos}, wrong flag`;
	    if (cell.flagged) return `${pos}, flagged`;
	    if (!cell.revealed) return `${pos}, hidden`;
	    if (cell.adj > 0) {
	      return `${pos}, ${cell.adj} adjacent mine${cell.adj === 1 ? "" : "s"}`;
	    }
	    return `${pos}, clear`;
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
    const g = this.getGeometry();
    const c = Math.floor((x - g.left) / g.cellW);
    const r = Math.floor((y - g.top) / g.cellH);
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return null;
    return { r, c, el: this.grid[r][c].el };
  }

  // Like cellFromPoint, but snaps to the NEAREST in-bounds cell so gutter/edge
  // gaze never falls into a dead zone. Returns null only when the point is
  // clearly off the board (outside the grid rect expanded by ~1 cell on every
  // side) so looking at the toolbar/menus doesn't snap to a cell.
  nearestCell(x, y) {
    const g = this.getGeometry();
    if (
      x < g.left - g.cellW || x > g.left + this.cols * g.cellW + g.cellW ||
      y < g.top - g.cellH || y > g.top + this.rows * g.cellH + g.cellH
    ) return null;
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor((x - g.left) / g.cellW)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor((y - g.top) / g.cellH)));
    return { r, c, el: this.grid[r][c].el };
  }
}
