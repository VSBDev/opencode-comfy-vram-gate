import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { StagingTracker } from "../src/staging.js"

async function exists(filePath) {
  try { await access(filePath); return true } catch { return false }
}

test("cleanup removes only generated outputs newly staged by this session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocvram-staging-test-"))
  const inputRoot = path.join(root, "input")
  const outputRoot = path.join(root, "output")
  await Promise.all([mkdir(inputRoot), mkdir(outputRoot)])
  const existing = path.join(inputRoot, "keep.png")
  await writeFile(existing, "real user input")
  const tracker = new StagingTracker(mergeConfig(DEFAULT_CONFIG, {
    staging: { enabled: true, hostInputRoot: inputRoot, generatedOutputRoots: [outputRoot] },
  }))

  try {
    const firstInput = { tool: "comfy_local_upload_file", sessionID: "s1", callID: "u1" }
    const firstOutput = { args: { paths: [path.join(outputRoot, "new.png")] } }
    assert.equal(await tracker.beforeUpload(firstInput, firstOutput), true)
    assert.equal(firstOutput.args.overwrite, false)
    const created = path.join(inputRoot, "new.png")
    await writeFile(created, "temporary generated output")
    await tracker.afterUpload(firstInput, { output: JSON.stringify({ uploads: [{ type: "input", cloud_name: "new.png", local_path: path.join(outputRoot, "new.png") }] }) })

    const secondInput = { tool: "comfy_local_upload_file", sessionID: "s1", callID: "u2" }
    const secondOutput = { args: { paths: [path.join(outputRoot, "keep.png")] } }
    await tracker.beforeUpload(secondInput, secondOutput)
    await tracker.afterUpload(secondInput, { output: JSON.stringify({ uploads: [{ type: "input", cloud_name: "keep.png", local_path: path.join(outputRoot, "keep.png") }] }) })

    const cleanup = await tracker.cleanup("s1")
    assert.deepEqual(cleanup.removed, [created])
    assert.equal(await exists(created), false)
    assert.equal(await exists(existing), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
