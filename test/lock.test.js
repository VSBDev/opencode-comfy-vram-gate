import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { GpuLockManager } from "../src/lock.js"

test("only one caller can hold a GPU lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocvram-lock-test-"))
  const lockPath = path.join(root, "gpu.lock")
  const first = new GpuLockManager({ lockPath, acquireTimeoutSeconds: 1, staleAfterSeconds: 60, heartbeatMs: 20, pollMs: 10 })
  const second = new GpuLockManager({ lockPath, acquireTimeoutSeconds: 0.05, staleAfterSeconds: 60, heartbeatMs: 20, pollMs: 10 })

  try {
    const lease = await first.acquire({ caller: "first" })
    await assert.rejects(() => second.acquire({ caller: "second" }), /Timed out acquiring GPU lease/)
    assert.equal((await first.owner()).caller, "first")
    assert.equal(await lease.release(), true)

    const next = await second.acquire({ caller: "second" })
    assert.equal((await second.owner()).caller, "second")
    await next.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
