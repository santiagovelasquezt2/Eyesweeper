import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../src/eye/eyetracking.js";

const { basis, solveLeastSquares, OneEuroFilter } = __test;

test("basis uses the expected linear and quadratic term counts", () => {
  const feat = { bgx: 1, bgy: 2, hx: 3, hy: 4, yaw: 5, pitch: 6 };

  assert.deepEqual(basis(feat, false), [1, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(basis(feat, true), [1, 1, 2, 1, 4, 2, 3, 4, 5, 6]);
});

test("least-squares solver recovers a simple linear fit", () => {
  const coeff = solveLeastSquares(
    [
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ],
    [2, 5, 8, 11]
  );

  assert.ok(coeff);
  assert.equal(coeff.length, 2);
  assert.ok(Math.abs(coeff[0] - 2) < 0.001);
  assert.ok(Math.abs(coeff[1] - 3) < 0.001);
});

test("OneEuroFilter handles repeated timestamps without producing NaN", () => {
  const filter = new OneEuroFilter();

  assert.equal(filter.filter(10, 1000), 10);
  const next = filter.filter(20, 1000);

  assert.equal(Number.isFinite(next), true);
});
