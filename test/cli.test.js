import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFlags, CliUsageError } from "../src/cli.js";

test("parseFlags: boolean flag", () => {
  const { flags, positionals } = parseFlags(["--json"], { json: { boolean: true } });
  assert.equal(flags.json, true);
  assert.deepEqual(positionals, []);
});

test("parseFlags: value flag via separate argv token", () => {
  const { flags } = parseFlags(["--title", "My Work"], { title: {} });
  assert.equal(flags.title, "My Work");
});

test("parseFlags: value flag via --name=value", () => {
  const { flags } = parseFlags(["--title=My Work"], { title: {} });
  assert.equal(flags.title, "My Work");
});

test("parseFlags: short alias with value", () => {
  const { flags } = parseFlags(["-o", "out.pdf"], { output: { alias: "o" } });
  assert.equal(flags.output, "out.pdf");
});

test("parseFlags: positionals interleaved with flags, in order", () => {
  const { flags, positionals } = parseFlags(["file.png", "--title", "T", "--json"], {
    title: {},
    json: { boolean: true },
  });
  assert.deepEqual(positionals, ["file.png"]);
  assert.equal(flags.title, "T");
  assert.equal(flags.json, true);
});

test("parseFlags: -- stops flag parsing, rest are positionals", () => {
  const { positionals } = parseFlags(["a", "--", "--not-a-flag", "-x"], {});
  assert.deepEqual(positionals, ["a", "--not-a-flag", "-x"]);
});

test("parseFlags: unknown long flag throws CliUsageError", () => {
  assert.throws(() => parseFlags(["--bogus"], {}), CliUsageError);
});

test("parseFlags: unknown short alias throws CliUsageError", () => {
  assert.throws(() => parseFlags(["-z"], { output: { alias: "o" } }), CliUsageError);
});

test("parseFlags: value flag missing its value throws CliUsageError", () => {
  assert.throws(() => parseFlags(["--title"], { title: {} }), CliUsageError);
});

test("parseFlags: boolean flag ignores any following token as a positional", () => {
  const { flags, positionals } = parseFlags(["--json", "file.png"], { json: { boolean: true } });
  assert.equal(flags.json, true);
  assert.deepEqual(positionals, ["file.png"]);
});
