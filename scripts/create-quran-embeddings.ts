/** One-time, resumable embedding build for the licensed public corpus only.
 * No caller data, generated interpretation, or bulk tafsir is persisted.
 * Run with OPENAI_API_KEY in the environment. --dry-run never calls a provider.
 * --seed-only validates existing checkpoints and produces SQL without API use.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { quranVerses } from "../apps/sakina/lib/quran-corpus";
import { QURAN_SPEECH_CORPUS } from "../apps/sakina/lib/quran-speech-data";
import { QURAN_CHAPTERS } from "../apps/sakina/lib/quran-catalog";
import {
  QURAN_EMBEDDING_MODEL as model,
  QURAN_EMBEDDING_DIMENSIONS as dimensions,
  QURAN_EMBEDDING_INPUT_VERSION as inputVersion,
  QURAN_EMBEDDING_SOURCE_SHA256 as sourceSha256,
  quranEmbeddingInput,
  readQuranEmbeddings,
  validQuranEmbedding,
} from "../apps/sakina/lib/quran-semantic";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const directory = "tmp/quran-intelligence/embeddings";
const batchSize = 64;
const seedBatchSize = 25;
const verses = quranVerses();
if (
  digest(QURAN_SPEECH_CORPUS) !== sourceSha256 ||
  verses.length !== 6236 ||
  new Set(verses.map((v) => v.key)).size !== 6236 ||
  QURAN_CHAPTERS.length !== 114 ||
  QURAN_CHAPTERS.some(
    (c) => verses.filter((v) => v.surah === c.surah).length !== c.ayahCount,
  )
)
  throw new Error("quran_source_coverage_or_hash_mismatch");
const inputs = verses.map((v) => {
  const input = quranEmbeddingInput(v.key);
  return { key: v.key, input, inputSha256: digest(input) };
});
const metadata = { model, dimensions, inputVersion, sourceSha256 };
if (process.argv.includes("--dry-run")) {
  console.log(
    JSON.stringify({
      ...metadata,
      verses: inputs.length,
      batches: Math.ceil(inputs.length / batchSize),
      seedBatches: Math.ceil(inputs.length / seedBatchSize),
      maxInputCharacters: Math.max(...inputs.map((i) => i.input.length)),
      apiCalled: false,
    }),
  );
  process.exit(0);
}
mkdirSync(`${directory}/batches`, { recursive: true });
mkdirSync(`${directory}/seed`, { recursive: true });
type Row = { key: string; inputSha256: string; embedding: number[] };
type Checkpoint = typeof metadata & { rows: Row[]; tokens: number };
const rows: Row[] = [];
let totalTokens = 0;
const key = process.env.OPENAI_API_KEY;
const seedOnly = process.argv.includes("--seed-only");
for (let offset = 0; offset < inputs.length; offset += batchSize) {
  const batch = inputs.slice(offset, offset + batchSize);
  const number = Math.floor(offset / batchSize) + 1;
  const filename = `${directory}/batches/${String(number).padStart(3, "0")}.json`;
  let checkpoint: Checkpoint;
  if (existsSync(filename)) {
    checkpoint = JSON.parse(readFileSync(filename, "utf8"));
  } else {
    if (seedOnly) throw new Error(`embedding_checkpoint_missing_${number}`);
    if (!key) throw new Error("OPENAI_API_KEY_missing");
    let result: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          dimensions,
          encoding_format: "float",
          input: batch.map((row) => row.input),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) {
        result = await response.json();
        break;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retrySeconds = Number(
          response.headers.get("retry-after") || 2 ** (attempt + 1),
        );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              30,
              Math.max(1, Number.isFinite(retrySeconds) ? retrySeconds : 2),
            ) * 1000,
          ),
        );
        continue;
      }
      throw new Error(
        `embedding_provider_http_${response.status}_batch_${number}`,
      );
    }
    const vectors = readQuranEmbeddings(result, batch.length);
    const tokens = (result as { usage?: { total_tokens?: unknown } })?.usage
      ?.total_tokens;
    checkpoint = {
      ...metadata,
      tokens:
        typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0,
      rows: batch.map((row, i) => ({
        key: row.key,
        inputSha256: row.inputSha256,
        embedding: vectors[i],
      })),
    };
    const pending = `${filename}.partial`;
    writeFileSync(pending, JSON.stringify(checkpoint));
    renameSync(pending, filename);
  }
  if (
    checkpoint.model !== model ||
    checkpoint.dimensions !== dimensions ||
    checkpoint.inputVersion !== inputVersion ||
    checkpoint.sourceSha256 !== sourceSha256 ||
    !Array.isArray(checkpoint.rows) ||
    checkpoint.rows.length !== batch.length ||
    checkpoint.rows.some(
      (row, i) =>
        row.key !== batch[i].key ||
        row.inputSha256 !== batch[i].inputSha256 ||
        !validQuranEmbedding(row.embedding),
    )
  )
    throw new Error(`embedding_checkpoint_mismatch_${number}`);
  rows.push(...checkpoint.rows);
  totalTokens += checkpoint.tokens || 0;
  console.log(
    JSON.stringify({
      batch: number,
      complete: rows.length,
      total: inputs.length,
    }),
  );
}
if (
  rows.length !== 6236 ||
  new Set(rows.map((row) => row.key)).size !== 6236 ||
  rows.some((row, i) => row.key !== inputs[i].key)
)
  throw new Error("embedding_full_coverage_mismatch");
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const seedFiles: { file: string; rows: number; sha256: string }[] = [];
for (let offset = 0; offset < rows.length; offset += seedBatchSize) {
  const batch = rows.slice(offset, offset + seedBatchSize);
  const values = batch
    .map(
      (row) =>
        `(${quote(row.key)},${quote(model)},${quote(sourceSha256)},${quote(inputVersion)},${quote(row.inputSha256)},${quote(JSON.stringify(row.embedding))}::extensions.vector)`,
    )
    .join(",\n");
  const sql = `insert into public.quran_verse_embeddings(verse_key,model,source_sha256,input_version,input_sha256,embedding) values ${values}\non conflict(verse_key) do update set model=excluded.model,source_sha256=excluded.source_sha256,input_version=excluded.input_version,input_sha256=excluded.input_sha256,embedding=excluded.embedding;\n`;
  const file = `${String(Math.floor(offset / seedBatchSize) + 1).padStart(3, "0")}.sql`;
  writeFileSync(`${directory}/seed/${file}`, sql);
  seedFiles.push({ file, rows: batch.length, sha256: digest(sql) });
}
writeFileSync(
  `${directory}/manifest.json`,
  JSON.stringify(
    { ...metadata, verses: rows.length, totalTokens, seedFiles },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    complete: true,
    verses: rows.length,
    seedBatches: seedFiles.length,
    totalTokens,
    directory,
  }),
);
