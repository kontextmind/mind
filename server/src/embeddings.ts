/**
 * Embeddings for hybrid search — provider-agnostic, OpenAI-compatible wire
 * format (OpenAI, compatible gateways, Ollama/llama.cpp local servers).
 * Injectability (KM_EMBEDDINGS_URL) keeps tests hermetic.
 *
 * Honesty contract: unconfigured → FTS-only search, said plainly. A failed
 * embedding call degrades to FTS — search never breaks on the vector path.
 * Dimension mismatches are loud (throw at ingest), never silent drift.
 */
import type { EmbeddingsConfig } from "./config";

export const EMBED_BATCH = 32;

/** Embedder = the subset of the provider surface the indexer/search need. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Build an embedder from config, or null when embeddings are unconfigured. */
export function embedderFor(cfg: { embeddings: EmbeddingsConfig | null }): EmbedFn | null {
  const ec = cfg.embeddings;
  if (!ec) return null;
  return (texts) => embedTexts(ec, texts);
}

/**
 * OpenAI-compatible POST {base}/embeddings. Validates count and dimension —
 * the chunks column is vector(${dim}), and a mismatch would poison the index.
 */
export async function embedTexts(
  ec: EmbeddingsConfig,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${ec.url.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ec.apiKey ? { authorization: `Bearer ${ec.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: ec.model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`embeddings endpoint ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ index: number; embedding: number[] }>;
  };
  return validateEmbeddings(body.data ?? [], texts.length, ec.dim);
}

/** Pure validation: count must match, order restored, dimension enforced. */
export function validateEmbeddings(
  data: Array<{ index: number; embedding: number[] }>,
  expectedCount: number,
  dim: number,
): number[][] {
  if (data.length !== expectedCount) {
    throw new Error(`embeddings returned ${data.length}/${expectedCount} vectors`);
  }
  // Order by index — providers are not required to reply in order.
  const sorted = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  for (const v of sorted) {
    if (!Array.isArray(v) || v.length !== dim) {
      throw new Error(
        `embedding dim ${Array.isArray(v) ? v.length : "?"} does not match configured ${dim} (KM_EMBEDDINGS_DIM)`,
      );
    }
  }
  return sorted;
}

/** Embed in batches; per-batch failures propagate to the caller. */
export async function embedInBatches(
  embed: EmbedFn,
  texts: string[],
  batchSize = EMBED_BATCH,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await embed(texts.slice(i, i + batchSize))));
  }
  return out;
}

/** pgvector literal '[0.1,0.2,…]' for cast(? as vector). */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Ingest/reconcile options slice for a config (embedder + version tag). */
export function embedOpts(cfg: {
  embeddings: EmbeddingsConfig | null;
}): { embed: EmbedFn | null; embedderVersion?: string } {
  return {
    embed: embedderFor(cfg),
    embedderVersion: cfg.embeddings?.model,
  };
}
