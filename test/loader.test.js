import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("loader generator creates an importable plugin and never overwrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocvram-loader-test-"))
  const target = path.join(root, "plugins", "comfy-vram-gate.js")
  const script = path.resolve("bin/create-loader.js")

  try {
    const created = spawnSync(process.execPath, [script, target], { encoding: "utf8" })
    assert.equal(created.status, 0, created.stderr)
    const module = await import(pathToFileURL(target).href)
    assert.equal(typeof module.ComfyVramGate, "function")

    const refused = spawnSync(process.execPath, [script, target], { encoding: "utf8" })
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /Refusing to overwrite/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
