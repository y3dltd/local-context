import { describe, expect, test } from "bun:test";
import { auditCitations, type CitationRead } from "../src/tools/ask.ts";

describe("auditCitations: confidence buckets", () => {
  const reads: CitationRead[] = [
    {
      file: "packages/ai/src/generate-text/stream-text.ts",
      line_start: 100,
      line_end: 150,
    },
    { file: "packages/zod/src/index.ts", line_start: 1, line_end: 50 },
  ];

  test("ok: exact path + line inside a recorded read", () => {
    const r = auditCitations(
      "Yes [packages/ai/src/generate-text/stream-text.ts:120].",
      reads,
      [],
    );
    expect(r.confidence).toBe("ok");
    expect(r.hasCitation).toBe(true);
  });

  test("ok: exact path + range inside a recorded read", () => {
    const r = auditCitations(
      "Range [packages/ai/src/generate-text/stream-text.ts:110-130].",
      reads,
      [],
    );
    expect(r.confidence).toBe("ok");
  });

  test("partial: model shortened the path to an unambiguous suffix", () => {
    // The model wrote stream-text.ts but read_file recorded the full
    // packages/ai/src/generate-text/stream-text.ts. Only one read ends
    // with that suffix, so we accept it as a partial-confidence match.
    const r = auditCitations("Yes [stream-text.ts:120].", reads, []);
    expect(r.confidence).toBe("partial");
    const auditValue = Object.values(r.audit)[0]!;
    expect(auditValue).toContain("suffix");
  });

  test("low: line outside any recorded read range", () => {
    const r = auditCitations(
      "[packages/zod/src/index.ts:9999]",
      reads,
      [],
    );
    expect(r.confidence).toBe("low");
  });

  test("low: range overshoots a recorded read", () => {
    // Range citation [10-9999] is invalid even though line 10 was read,
    // because the upper bound is outside what was actually returned.
    const r = auditCitations(
      "[packages/zod/src/index.ts:10-9999]",
      reads,
      [],
    );
    expect(r.confidence).toBe("low");
  });

  test("low: inverted range is malformed", () => {
    const r = auditCitations(
      "[packages/zod/src/index.ts:30-10]",
      reads,
      [],
    );
    expect(r.confidence).toBe("low");
  });

  test("low: zero citations", () => {
    const r = auditCitations("just prose, no citation.", reads, []);
    expect(r.confidence).toBe("low");
    expect(r.hasCitation).toBe(false);
  });

  test("ok: tolerates a 'file:' prefix that small models copy from caller prompts", () => {
    // Real-world bug: caller's question said "Include [file:line]
    // citations". The 2B model copied that template literally and
    // emitted [file:src/foo.ts:42] which the old regex rejected.
    // Both forms must validate identically.
    const r = auditCitations(
      "Defined at [file:packages/ai/src/generate-text/stream-text.ts:120].",
      reads,
      [],
    );
    expect(r.confidence).toBe("ok");
    expect(r.hasCitation).toBe(true);
  });

  test("ok: mixed [file:...] and bare [...] citations in one answer", () => {
    const r = auditCitations(
      "See [file:packages/zod/src/index.ts:5] and [packages/ai/src/generate-text/stream-text.ts:120].",
      reads,
      [],
    );
    expect(r.confidence).toBe("ok");
  });

  test("low: ambiguous suffix (two index.ts under different packages)", () => {
    const ambiguousReads: CitationRead[] = [
      { file: "packages/foo/src/index.ts", line_start: 1, line_end: 50 },
      { file: "packages/bar/src/index.ts", line_start: 1, line_end: 50 },
    ];
    const r = auditCitations("[index.ts:10]", ambiguousReads, []);
    expect(r.confidence).toBe("low");
    expect(Object.values(r.audit)[0]).toContain("ambiguous");
  });

  test("ok: URL citation matches a fetched URL", () => {
    const r = auditCitations(
      "yes [https://example.com/post]",
      [],
      ["https://example.com/post"],
    );
    expect(r.confidence).toBe("ok");
  });

  test("low: URL citation that was not fetched", () => {
    const r = auditCitations("no [https://other.com/post]", [], []);
    expect(r.confidence).toBe("low");
  });

  test("mixed: exact + suffix => partial", () => {
    // First citation is exact, second is a suffix-only shortcut. Mixed
    // exact+suffix should land in partial because the parent agent
    // still benefits from knowing at least one citation needed
    // suffix-resolution.
    const r = auditCitations(
      "[packages/zod/src/index.ts:5] and [stream-text.ts:120]",
      reads,
      [],
    );
    expect(r.confidence).toBe("partial");
  });

  test("mixed: one good + one unmatched => low", () => {
    const r = auditCitations(
      "[packages/zod/src/index.ts:5] but [evil.ts:1]",
      reads,
      [],
    );
    expect(r.confidence).toBe("low");
  });
});
