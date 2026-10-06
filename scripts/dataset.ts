/** Offline verification and restoration. Never calls an API or writes to a database. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { quranVerses } from "../apps/sakina/lib/quran-corpus";
import { QURAN_SPEECH_CORPUS, QURAN_SPEECH_SOURCE } from "../apps/sakina/lib/quran-speech-data";
import { quranEmbeddingInput, validQuranEmbedding, QURAN_EMBEDDING_MODEL, QURAN_EMBEDDING_INPUT_VERSION } from "../apps/sakina/lib/quran-semantic";
const command = process.argv[2] || "verify";
if (!["verify", "restore"].includes(command)) throw new Error("Use verify or restore");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): never => { throw new Error(message); };
const manifest = JSON.parse(readFileSync("dataset/manifest.json", "utf8"));
if (manifest.version !== 1 || manifest.chapters !== 114 || manifest.verses !== 6236 || manifest.dimensions !== 1024 || manifest.model !== QURAN_EMBEDDING_MODEL || manifest.inputVersion !== QURAN_EMBEDDING_INPUT_VERSION || manifest.sourceSha256 !== QURAN_SPEECH_SOURCE.sha256 || !Array.isArray(manifest.files) || manifest.files.length !== 98) fail("dataset_manifest_invalid");
const source = readFileSync("dataset/quran-simple-clean-1.1.txt");
if (digest(source) !== manifest.sourceSha256 || source.toString("utf8") !== QURAN_SPEECH_CORPUS) fail("verbatim_source_mismatch");
const catalog = readFileSync("dataset/recitations.json");
if (digest(catalog) !== manifest.catalogSha256 || !catalog.equals(readFileSync("apps/sakina/lib/data/quran-catalog.json"))) fail("catalog_mismatch");
const expected = quranVerses();
let offset = 0;
const verified: Array<{name: string; raw: Buffer}> = [];
const names = new Set<string>();
for (const [index, entry] of manifest.files.entries()) {
  const name = `${String(index + 1).padStart(3, "0")}.json.gz`;
  if (entry.file !== name || names.has(name)) fail("invalid_shard_path_or_order");
  names.add(name);
  const compressed = readFileSync(`dataset/embeddings/${name}`);
  if (compressed.length !== entry.bytes || compressed.length > 600000 || digest(compressed) !== entry.sha256) fail(`shard_checksum_${index}`);
  const raw = gunzipSync(compressed, { maxOutputLength: 1500000 });
  if (digest(raw) !== entry.uncompressedSha256) fail(`shard_content_${index}`);
  const data = JSON.parse(raw.toString("utf8"));
  if (Object.keys(data).sort().join() !== ["dimensions","inputVersion","model","rows","sourceSha256","tokens"].sort().join() || data.model !== manifest.model || data.dimensions !== manifest.dimensions || data.sourceSha256 !== manifest.sourceSha256 || data.inputVersion !== manifest.inputVersion || !Array.isArray(data.rows) || data.rows.length !== entry.rows || data.rows.length !== Math.min(64, 6236 - offset)) fail(`shard_metadata_${index}`);
  for (const row of data.rows) {
    if (Object.keys(row).sort().join() !== ["embedding","inputSha256","key"].sort().join() || row.key !== expected[offset]?.key || !validQuranEmbedding(row.embedding) || row.inputSha256 !== digest(quranEmbeddingInput(row.key))) fail(`verse_embedding_${offset}`);
    offset++;
  }
  verified.push({name: name.slice(0,-3), raw});
}
if (offset !== 6236 || readdirSync("dataset/embeddings").some(name => !names.has(name))) fail("dataset_coverage_invalid");
if (command === "restore") {
  const target = "tmp/quran-intelligence/embeddings/batches";
  mkdirSync(target, {recursive:true});
  for (const {name,raw} of verified) writeFileSync(`${target}/${name}`,raw);
}
console.log(JSON.stringify({verified:true,chapters:114,verses:offset,shards:verified.length,restored:command === "restore",apiCalls:0}));
