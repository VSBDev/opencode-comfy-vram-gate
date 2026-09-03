import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_CONFIG, loadConfig, mergeConfig, parseEnv } from "../src/config.js"

test("configuration overlays defaults without mutating them", () => {
  const config = mergeConfig(DEFAULT_CONFIG, {
    ollama: { url: "http://ollama.test:11434/", unloadPolicy: "listed", models: ["qwen"] },
    gpu: { minimumFreeMiB: 28_000 },
  })

  assert.equal(config.ollama.url, "http://ollama.test:11434")
  assert.equal(config.ollama.unloadPolicy, "listed")
  assert.deepEqual(config.ollama.models, ["qwen"])
  assert.equal(config.gpu.minimumFreeMiB, 28_000)
  assert.equal(DEFAULT_CONFIG.gpu.minimumFreeMiB, null)
})

test("invalid or unsafe configuration is rejected", () => {
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { ollama: { url: "file:///tmp/socket" } }), /http or https/)
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { ollama: { unloadPolicy: "listed", models: [] } }), /cannot be empty/)
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { gpu: { minimumFreeRatio: 1.1 } }), /at most 1/)
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { gpu: { deviceIndex: 0.5 } }), /non-negative integer/)
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { plugin: { forceBlocking: "false" } }), /true or false/)
  assert.throws(() => mergeConfig(DEFAULT_CONFIG, { staging: { enabled: true } }), /hostInputRoot/)
})

test("dotenv parsing is data-only and supports quoted values", () => {
  assert.deepEqual(parseEnv(`
# comment
export OCVRAM_COMFY_URL="http://render-host:8188"
OCVRAM_OLLAMA_MODELS='model-a:tag,model-b:tag'
OCVRAM_FORCE_BLOCKING=true # inline comment
`), {
    OCVRAM_COMFY_URL: "http://render-host:8188",
    OCVRAM_OLLAMA_MODELS: "model-a:tag,model-b:tag",
    OCVRAM_FORCE_BLOCKING: "true",
  })
  assert.throws(() => parseEnv("not shell code"), /line 1/)
})

test("private dotenv values override JSON without entering public config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocvram-config-test-"))
  const dotenv = path.join(root, ".env")
  await writeFile(dotenv, [
    "OCVRAM_COMFY_URL=http://render-host:8188",
    "OCVRAM_MIN_FREE_MIB=24000",
    "OCVRAM_HEAVY_TOOL_SUFFIXES=render_image,render_video",
  ].join("\n"))

  try {
    const config = await loadConfig({ env: {}, dotenvPaths: [dotenv], jsonPaths: [] })
    assert.equal(config.comfy.url, "http://render-host:8188")
    assert.equal(config.gpu.minimumFreeMiB, 24_000)
    assert.deepEqual(config.plugin.heavyToolSuffixes, ["render_image", "render_video"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
