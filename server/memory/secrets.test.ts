import { describe, expect, it } from "bun:test";

import { scanForSecrets } from "./secrets.ts";

// Each made of parts, so no repository scanner takes the fixtures for leaked credentials
const joined = (...parts: string[]) => parts.join("");
const SECRET_SHAPED = [
  joined("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"),
  joined("deploy with AKIA", "IOSFODNN7EXAMPLE"),
  joined("the bot uses gh", "p_16C7e42F292c6912E7710c838347Ae178B4a"),
  joined("github", "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGH"),
  joined("openai sk", "-proj-Q9x2Lm7Np4Rt8Vw3Yz6Bc1Df5Gh0Jk"),
  joined("anthropic sk", "-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
  joined("slack xo", "xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
  joined("maps AI", "zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  joined("stripe sk", "_live_51H8xYzAbCdEfGhIjKlMnOp"),
  joined("np", "m_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
  joined("AGE-SECRET", "-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS"),
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "clone https://deploy:hunter2hunter2@git.example.com/team/app.git",
  "password: correct-horse-battery",
  "API_KEY=8f14e45fceea167a5a36dedd4bea2543",
  "Authorization: Bearer abcdefghijklmnop",
  "the db secret = s3cr3t-v4lue-here",
  "token: 'qwertyuiopasdf'",
  "OPENAI_BASE=https://api.example.com\nOPENAI_MODEL=gpt\nOPENAI_ORG=acme",
  "```\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\n```",
];

describe("scanForSecrets", () => {
  it.each(SECRET_SHAPED)("refuses %p", (text) => {
    expect(scanForSecrets(text, []).verdict).toBe("refuse");
  });

  it("names the rule without the value", () => {
    const found = scanForSecrets(joined("deploy with AKIA", "IOSFODNN7EXAMPLE"), []);
    expect(found).toEqual({ verdict: "refuse", rule: "aws_access_key" });
  });

  it.each([
    "Run bun test once; no fixed sleeps.",
    "Release notes go in changelog.d fragments.",
    "The session 6f0c2a51-3b7e-4d19-9a40-c1e27d5b8f03 wrote this.",
    "Entry 01KA81B6YH3D0V7KQ2MZT4NPRS replaces the old one.",
    "The team proxy key is in the vault's team/proxy-key; the value is not here.",
    "PR titles are in English, the issue number on the body's first line.",
  ])("lets plain notes through: %p", (text) => {
    expect(scanForSecrets(text, []).verdict).toBe("clean");
  });

  it("asks about a long random-looking string, which a real fact can be", () => {
    expect(scanForSecrets("the release bucket is rv-3b02727e81f6ed8e3801d3fa-", [])).toEqual({ verdict: "ask", rule: "random_string" });
  });

  it("refuses a known secret even reversed, in hex, in base64 or cut in half", () => {
    const known = "Zq8vLw3pN2mR7tY4";
    const reversed = [...known].reverse().join("");
    const hex = Buffer.from(known).toString("hex");
    const base64 = Buffer.from(known).toString("base64");
    for (const text of [`it is ${known}`, `it is ${reversed}`, `hex ${hex}`, `b64 ${base64}`, `first ${known.slice(0, 8)} then`]) {
      expect(scanForSecrets(text, [known])).toEqual({ verdict: "refuse", rule: "known_secret" });
    }
    expect(scanForSecrets("nothing of it here", [known]).verdict).toBe("clean");
  });
});
