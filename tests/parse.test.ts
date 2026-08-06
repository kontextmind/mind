import { describe, expect, test } from "bun:test";
import { chunkPage, parseFrontmatter, wikilinks } from "../server/src/indexer/parse";

describe("parseFrontmatter", () => {
  test("extracts title/status/superseded_by", () => {
    const src = `---\ntitle: Test Page\nstatus: verified\nsuperseded_by: other/page.md\n---\n\n# Body\n`;
    const { meta, body } = parseFrontmatter(src);
    expect(meta.title).toBe("Test Page");
    expect(meta.status).toBe("verified");
    expect(meta.supersededBy).toBe("other/page.md");
    expect(body).toContain("# Body");
  });

  test("handles missing frontmatter", () => {
    const { meta, body } = parseFrontmatter("# Just a heading\ntext");
    expect(meta.title).toBeNull();
    expect(body).toContain("Just a heading");
  });
});

describe("chunkPage (board decision D5: fence-aware)", () => {
  test("a ## inside a fenced code block is NOT a heading", () => {
    const src = [
      "# Real heading",
      "",
      "Intro text.",
      "",
      "```markdown",
      "## this looks like a heading but is inside a fence",
      "```",
      "",
      "After text.",
    ].join("\n");
    const { chunks } = chunkPage(src);
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe("Real heading");
    expect(chunks[0].content).toContain("## this looks like a heading");
    expect(chunks[0].content).toContain("After text.");
  });

  test("splits on real headings", () => {
    const src = "# A\n\nfirst\n\n## B\n\nsecond\n";
    const { chunks } = chunkPage(src);
    expect(chunks.map((c) => c.heading)).toEqual(["A", "B"]);
  });

  test("oversized sections split on paragraph boundaries under the cap", () => {
    const para = "x".repeat(400);
    const src = `# Big\n\n${[para, para, para, para].join("\n\n")}\n`;
    const { chunks } = chunkPage(src);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1500);
  });
});

describe("wikilinks", () => {
  test("extracts targets, strips aliases and anchors", () => {
    const src = "See [[page-one]] and [[page-two|alias]] and [[page-three#section]].";
    expect(wikilinks(src).sort()).toEqual(["page-one", "page-three", "page-two"]);
  });
});
