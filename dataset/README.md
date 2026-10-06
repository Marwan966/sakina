# Quran dataset

This package contains public Quran data only. No caller data, prompts, conversation vectors, credentials or database runtime records are included.

| File | Contents |
| --- | --- |
| `quran-simple-clean-1.1.txt` | Exact original Tanzil Simple Clean 1.1 download: 114 chapters, 6236 verses, original notice |
| `recitations.json` | MP3Quran chapter names, original Yasser Al-Dosari recording links and all publisher verse intervals; verse counts checked against Tanzil |
| `embeddings/*.json.gz` | 98 losslessly compressed shards covering all 6236 verses; 1024-dimensional `text-embedding-3-large` vectors |
| `manifest.json` | SHA-256 checksums, source/version/model/dimension metadata and row counts |

The vector input consists of the target verse and separately labeled adjacent verses from the same chapter (`tanzil-target-neighbors-v1`). It contains no generated interpretation or downloaded tafsir. Rankings are candidates, not proof of religious relevance: runtime selection checks exact text, context and sourced tafsir.

Run from the repository root:

```sh
npm run dataset:verify
npm run dataset:restore
npm run dataset:sql
```

Verification checks compressed and decompressed checksums, exact scripture bytes, every verse key, source-input hash, vector dimensions/norm and full coverage. Restore writes only to ignored `tmp/quran-intelligence/embeddings/batches`. SQL generation produces 64 corpus batches and 250 embedding batches under `tmp/quran-intelligence`; it makes no API call and performs no database writes. Apply the reviewed SQL to your own database as explained in [setup](../docs/SETUP.md).

The exact Tanzil source SHA-256 is `228df2a717671aeb9d2ff573002bd28d6b3f973f4bc7153554e3a81663d67610`. Preserve the [full original copyright notice](LICENSE-TANZIL.txt), attribution and text unchanged. [Tanzil license](https://tanzil.net/docs/text_license) · [source updates](https://tanzil.net/updates/).

Recording metadata and links come from [MP3Quran's API](https://www.mp3quran.net/api/v3/reciters?language=ar&reciter=92) and [chapter list](https://www.mp3quran.net/api/v3/suwar?language=ar); see [its reuse policy](https://www.mp3quran.net/ar/privacy). Recordings are streamed directly, not bundled or relicensed here. Quran Foundation tafsir/API responses are not included.
