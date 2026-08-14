import { describe, expect, test } from "bun:test";
import { chunk } from "../src/utils.js";

describe("chunk", () => {
  test("splits preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("a short list stays whole", () => {
    expect(chunk([1, 2], 50)).toEqual([[1, 2]]);
  });

  test("an empty list yields no chunks", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  test("rejects a zero size instead of looping forever", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
