import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { askProject } from "../src/tools/ask.ts";

const cfg: Config = {
  modelEndpoint: "http://127.0.0.1:11434/v1",
  model: "test-model",
  reposDir: "/tmp/local-context-test-repos",
  maxAnswerTokens: 4096,
  catalog: {},
  rootDir: "/tmp/local-context-test-root",
};

describe("askProject input contract", () => {
  test("rejects missing version before resolving or cloning", async () => {
    const out = await askProject(cfg, {
      project: "https://github.com/example/example.git",
      question: "What does example do?",
    });

    expect(out.status).toBe("error");
    expect(out.error).toContain("requires an explicit version");
    // steps is opt-in via debug:true; it must be absent on error responses
    // that never invoked the agent.
    expect(out.steps).toBeUndefined();
    expect(out.tokens).toBeUndefined();
  });

  test("rejects blank version before resolving or cloning", async () => {
    const out = await askProject(cfg, {
      project: "https://github.com/example/example.git",
      version: "   ",
      question: "What does example do?",
    });

    expect(out.status).toBe("error");
    expect(out.error).toContain("requires an explicit version");
    expect(out.steps).toBeUndefined();
    expect(out.tokens).toBeUndefined();
  });
});
