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

test("recovery unloads a model that reloaded after a failed tool", async () => {
  const item = await fixture()
  try {
    const handoff = await item.gate.before({ callID: "failed-tool" })
    item.state.models = ["large-local-model:latest"]
    item.state.freeMiB = 7_000

    const recovered = await item.gate.recover(handoff.lease)
    assert.deepEqual(recovered.unloadedOllamaModels, ["large-local-model:latest"])
    assert.equal(item.state.ollamaUnloadRequests.length, 2)
    assert.equal(item.state.comfyFreeRequests, 2)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("a non-Comfy consumer unloads before the shared lease is released", async () => {
  const item = await fixture()
  const calls = []
  try {
    const handoff = await item.gate.beforeConsumer({ consumer: "external-renderer", callID: "render-1" })
    assert.equal((await item.gate.lock.owner()).consumer, "external-renderer")
    assert.equal((await item.gate.lock.owner()).target, "local-consumer")

    item.state.models = ["another-agent:latest"]
    item.state.freeMiB = 9_000
    const handback = await item.gate.afterConsumer(handoff.lease, {
      label: "External renderer",
      waitForConsumerIdle: async () => calls.push("idle"),
      releaseConsumer: async () => calls.push("released"),
    })

    assert.deepEqual(calls, ["idle", "released"])
    assert.deepEqual(handback.unloadedOllamaModels, ["another-agent:latest"])
    assert.equal(handback.freeMiB, 32_768)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("a local consumer can declare a smaller task-specific free-VRAM requirement", async () => {
  const item = await fixture({ freedMiB: 24_000 })
  try {
    const handoff = await item.gate.beforeConsumer(
      { consumer: "image-renderer", callID: "render-small" },
      { requiredFreeMiB: 22_000 },
    )
    assert.equal(handoff.detail.targetMiB, 22_000)
    assert.equal(handoff.lease.owner.requiredFreeMiB, 22_000)

    const handback = await item.gate.afterConsumer(handoff.lease, {
      releaseConsumer: async () => ({ workers: "stopped" }),
    })
    assert.equal(handback.targetMiB, 22_000)
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("the configured free-VRAM target still applies when a consumer omits a requirement", async () => {
  const item = await fixture({ freedMiB: 24_000 })
  try {
    await assert.rejects(
      () => item.gate.beforeConsumer({ consumer: "default-renderer", callID: "render-default", requiredFreeMiB: 1 }),
      /at least 28000 MiB free VRAM/,
    )
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})

test("a failed non-Comfy release keeps the lease available for recovery", async () => {
  const item = await fixture()
  try {
    const handoff = await item.gate.beforeConsumer({ consumer: "external-renderer", callID: "render-2" })
    await assert.rejects(() => item.gate.afterConsumer(handoff.lease, {
      label: "External renderer",
      releaseConsumer: async () => { throw new Error("worker did not stop") },
    }), /worker did not stop/)
    assert.equal((await item.gate.lock.owner()).callID, "render-2")

    const recovered = await item.gate.recoverConsumer(handoff.lease, {
      label: "External renderer",
      releaseConsumer: async () => ({ workers: "stopped" }),
    })
    assert.deepEqual(recovered.consumer, { workers: "stopped" })
    assert.equal(await item.gate.lock.owner(), null)
  } finally {
    await item.dispose()
  }
})
