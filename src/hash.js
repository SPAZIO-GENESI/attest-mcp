import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

// Streams the file through SHA-256 without ever loading it fully into memory
// or sending its bytes anywhere — full privacy, same guarantee as the browser
// client (WebCrypto) and the imgauth API contract (POST /api/hash takes only
// the digest). Works for files well beyond the browser's 1 GB cap.
export async function hashFile(path) {
  const { size } = await stat(path);
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { sha256: digest.digest("hex"), size };
}
