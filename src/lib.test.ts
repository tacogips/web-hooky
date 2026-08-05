import { describe, expect, test } from "bun:test";
import { add, greet } from "./lib";

describe("greet", () => {
  test("returns greeting with name", () => {
    expect(greet("World")).toBe("Hello, World!");
  });

  test("returns greeting with different name", () => {
    expect(greet("Bun")).toBe("Hello, Bun!");
  });
});

describe("add", () => {
  test("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  test("adds negative numbers", () => {
    expect(add(-1, -2)).toBe(-3);
  });

  test("adds zero", () => {
    expect(add(5, 0)).toBe(5);
  });
});
