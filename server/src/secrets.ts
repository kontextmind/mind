/**
 * Gate 2 — deterministic secret scanning (docs/secret-gates.md).
 * LLM redaction is defense-in-depth; THIS is the control. Runs on every
 * KontextMind→git commit. On hit: block, quarantine, notify — never commit.
 *
 * Scanners are deliberately simple + high-precision. False negatives are
 * accepted for novel formats (documented); false positives get an
 * override-with-audit path at the review layer.
 */

export interface ScanFinding {
  rule: string;
  /** Never expose the matched secret itself — rule id + location only. */
  line: number;
}

export interface ScanResult {
  clean: boolean;
  findings: ScanFinding[];
}

interface PatternRule {
  rule: string;
  re: RegExp;
}

const PATTERN_RULES: PatternRule[] = [
  { rule: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}[A-Za-z0-9_-]*\b/g },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { rule: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { rule: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { rule: "connection-string", re: /\b(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:@]+:[^\s@]+@/gi },
  { rule: "bearer-literal", re: /["']?[Bb]earer\s+[A-Za-z0-9._~-]{24,}["']?/g },
  { rule: "generic-secret-assign", re: /\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/gi },
];

/**
 * High-entropy hex/base64 blobs that look like credentials (32+ chars).
 * Kept conservative to limit false positives on SHAs-in-context.
 */
const ENTROPY_MIN_LEN = 40;

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function entropyFindings(content: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
      const blob = m[0];
      if (blob.length < ENTROPY_MIN_LEN) continue;
      if (/^[0-9a-f]{40,64}$/i.test(blob)) continue; // git SHAs, hashes
      if (shannon(blob) >= 4.5) {
        out.push({ rule: "high-entropy-blob", line: i + 1 });
        break; // one finding per line is enough
      }
    }
  }
  return out;
}

export function scanContent(
  content: string,
  opts?: { denylist?: string[] },
): ScanResult {
  const findings: ScanFinding[] = [];
  const lines = content.split("\n");

  for (const { rule, re } of PATTERN_RULES) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) findings.push({ rule, line: i + 1 });
    }
  }

  findings.push(...entropyFindings(content));

  for (const term of opts?.denylist ?? []) {
    if (!term.trim()) continue;
    const needle = term.trim().toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        findings.push({ rule: `denylist:${term.trim()}`, line: i + 1 });
      }
    }
  }

  // Dedupe by rule+line
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = `${f.rule}@${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { clean: deduped.length === 0, findings: deduped };
}

/**
 * Low-risk one-liner test for relaxed-mode auto-promotion (docs/trust-modes.md):
 * single sentence, short, no code, no paths/URLs, no secrets (caller already
 * ran scanContent).
 */
export function isLowRiskLearning(content: string): boolean {
  const body = content.replace(/^---[\s\S]*?---\n?/, "").trim();
  if (body.length > 200) return false;
  if (/```|`/.test(body)) return false;
  if (/https?:\/\/|\b[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(md|ts|js|sql|json)\b/.test(body)) return false;
  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  return sentences.length <= 2;
}
