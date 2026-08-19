import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { VramGate } from "../src/gate.js"
import { startMockServices } from "./helpers.js"

async function fixture(options) {
  const services = await startMockServices(options)
  const root = await mkdtemp(path.join(tmpdir(), "ocvram-gate-test-"))
  const config = mergeConfig(DEFAULT_CONFIG, {
    ollama: { url: services.ollamaUrl },
    comfy: { url: services.comfyUrl },
    gpu: { minimumFreeMiB: 28_000 },
    timeouts: { requestMs: 1_000, handoffSeconds: 1, renderSeconds: 1, pollMs: 10 },
    lock: { path: path.join(root, "gpu.lock"), acquireTimeoutSeconds: 0.2, staleAfterSeconds: 60, heartbeatMs: 20 },
  })
  return {
    ...services,
    root,
    gate: new VramGate(config),
    async dispose() {
      await services.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("handoff unloads Ollama, frees ComfyUI, and holds the lease until handback", async () => {
  const item = await fixture()
  try {
    const handoff = await item.gate.before({ sessionID: "s1", callID: "c1" })
    assert.deepEqual(handoff.detail.unloadedOllamaModels, ["large-local-model:latest"])
    assert.equal(item.state.ollamaUnloadRequests[0].keep_alive, 0)
    assert.equal(item.state.comfyFreeRequests, 1)
    assert.equal((await item.gate.lock.owner()).callID, "c1")

    const handback = await item.gate.after(handoff.lease)
    assert.equal(handback.freeMiB, 32_768)
    assert.equal(item.state.comfyFreeRequests, 2)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("a busy ComfyUI queue is never interrupted and the lease is released", async () => {
  const item = await fixture({ busy: true })
  try {
    await assert.rejects(() => item.gate.before({ callID: "busy" }), /ComfyUI is busy/)
    assert.deepEqual(item.state.models, ["large-local-model:latest"])
    assert.equal(item.state.comfyFreeRequests, 0)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("handback waits for a prematurely returning tool's ComfyUI job", async () => {
  const item = await fixture()
  try {
    const handoff = await item.gate.before({ callID: "delayed" })
    item.state.queue = { queue_running: [[1]], queue_pending: [] }
    setTimeout(() => {
      item.state.queue = { queue_running: [], queue_pending: [] }
      item.state.freeMiB = 7_000
    }, 40)

    const handback = await item.gate.after(handoff.lease)
    assert.equal(handback.freeMiB, 32_768)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("a failed handback keeps its lease until recovery", async () => {
  const item = await fixture()
  try {
    const handoff = await item.gate.before({ callID: "recover-me" })
    item.gate.waitForComfyIdle = async () => { throw new Error("transport ended while render state is unknown") }

    await assert.rejects(() => item.gate.after(handoff.lease), /GPU handback failed/)
    assert.equal((await item.gate.lock.owner()).callID, "recover-me")
    await assert.rejects(() => item.gate.recover(handoff.lease), /render state is unknown/)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})
