import { describe, expect, it } from "vitest";
import { getInitialPassword, isStrongInitialPassword } from "@/lib/auth/passwordPolicy";

describe("initial password policy", () => {
  it("keeps the default when nothing is configured", () => {
    expect(getInitialPassword({ NODE_ENV: "production" })).toBe("123456");
  });

  it("refuses placeholders in production", () => {
    for (const weak of ["123456", "change-me", "Password", "changeme"]) {
      expect(getInitialPassword({ NODE_ENV: "production", INITIAL_PASSWORD: weak })).toBeNull();
      expect(isStrongInitialPassword(weak)).toBe(false);
    }
  });

  it("refuses anything shorter than 12 characters in production", () => {
    expect(getInitialPassword({ NODE_ENV: "production", INITIAL_PASSWORD: "abc12345" })).toBeNull();
    expect(getInitialPassword({ NODE_ENV: "production", INITIAL_PASSWORD: "a".repeat(11) })).toBeNull();
  });

  it("accepts a long non-placeholder value in production", () => {
    const strong = "correct-horse-battery-staple";
    expect(isStrongInitialPassword(strong)).toBe(true);
    expect(getInitialPassword({ NODE_ENV: "production", INITIAL_PASSWORD: strong })).toBe(strong);
  });

  it("leaves the local development path untouched", () => {
    expect(getInitialPassword({ NODE_ENV: "development", INITIAL_PASSWORD: "dev" })).toBe("dev");
  });
});
