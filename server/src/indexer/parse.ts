/**
 * Markdown → chunks. Fence-aware via marked's lexer: a `##` inside a fenced
 * code block is NOT a heading (board decision D5 — this failure mode is why
 * we parse instead of regex-splitting).
 *
 * Chunking: heading-aware sections, ~1500-char cap, NO overlap (FTS-only in
 * 1a; overlap duplicates phrases and pollutes ranking — revisit with
 * embeddings). Oversized sections split on paragraph boundaries.
 */
import { Marked } from "marked";

export interface PageMeta {
  title: string | null;
  status: string | null;
  supersededBy: string | null;
  frontmatter: Record<string, unknown>;
}

export interface Chunk {
  ord: number;
  heading: string | null;
  content: string;
}

const CHUNK_CAP = 1500;

export function parseFrontmatter(src: string): {
  meta: PageMeta;
  body: string;
} {
  let body = src;
  let fm: Record<string, unknown> = {};
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return {
    meta: {
      title: (fm.title as string) ?? null,
      status: (fm.status as string) ?? null,
      supersededBy: (fm.superseded_by as string) ?? null,
      frontmatter: fm,
    },
    body,
  };
}

interface Section {
  heading: string | null;
  text: string;
}

function sections(body: string): Section[] {
  const tokens = new Marked().lexer(body);
  const out: Section[] = [];
  let cur: Section = { heading: null, text: "" };
  const flush = () => {
    if (cur.text.trim()) out.push(cur);
    cur = { heading: null, text: "" };
  };
  for (const tok of tokens) {
    if (tok.type === "heading") {
      flush();
      cur = { heading: tok.text, text: "" };
    } else if ("raw" in tok) {
      cur.text += tok.raw;
    }
  }
  flush();
  return out;
}

export function chunkPage(src: string): { meta: PageMeta; chunks: Chunk[] } {
  const { meta, body } = parseFrontmatter(src);
  const chunks: Chunk[] = [];
  for (const sec of sections(body)) {
    const text = sec.text.trim();
    if (!text) continue;
    if (text.length <= CHUNK_CAP) {
      chunks.push({ ord: chunks.length, heading: sec.heading, content: text });
      continue;
    }
    // Oversized section: split on paragraph boundaries, pack up to the cap.
    let buf = "";
    for (const para of text.split(/\n{2,}/)) {
      if (buf.length + para.length + 2 > CHUNK_CAP && buf) {
        chunks.push({ ord: chunks.length, heading: sec.heading, content: buf.trim() });
        buf = "";
      }
      buf += (buf ? "\n\n" : "") + para;
    }
    if (buf.trim()) {
      chunks.push({ ord: chunks.length, heading: sec.heading, content: buf.trim() });
    }
  }
  return { meta, chunks };
}

/** Extract [[wikilink]] targets (graph_edges population, best-effort). */
export function wikilinks(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    out.add(m[1].trim());
  }
  return [...out];
}
