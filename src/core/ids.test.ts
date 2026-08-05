import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  hmacSha256Base64,
  hmacSha256Hex,
  newKeyId,
  newSecret,
  newUuid,
  sha256Hex,
  timingSafeEqualString,
} from "./ids";

describe("identifier generation", () => {
  test("produces distinct uuids", () => {
    expect(newUuid()).not.toBe(newUuid());
  });

  test("produces url-safe secrets", () => {
    const secret = newSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });

  test("key ids are shorter than secrets", () => {
    expect(newKeyId().length).toBeLessThan(newSecret().length);
  });
});

describe("hashing", () => {
  test("sha256 matches the known digest of an empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("hmac-sha256 matches the RFC 4231 test case 1 digest", async () => {
    // key = 20 bytes of 0x0b, data = "Hi There"
    const key = "\x0b".repeat(20);
    expect(await hmacSha256Hex(key, "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("base64 and hex encodings describe the same digest", async () => {
    const base64 = await hmacSha256Base64("secret", "body");
    const hex = await hmacSha256Hex("secret", "body");
    const decoded = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    expect(bytesToHex(decoded)).toBe(hex);
  });
});

describe("timingSafeEqualString", () => {
  test("returns true only for identical values", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});
