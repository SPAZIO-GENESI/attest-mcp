import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashFile } from "../src/hash.js";

test("hashFile matches known SHA-256 vectors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attest-mcp-test-"));
  try {
    const empty = join(dir, "empty.bin");
    await writeFile(empty, Buffer.alloc(0));
    const emptyResult = await hashFile(empty);
    assert.equal(emptyResult.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(emptyResult.size, 0);

    const abc = join(dir, "abc.txt");
    await writeFile(abc, "abc");
    const abcResult = await hashFile(abc);
    assert.equal(abcResult.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(abcResult.size, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
