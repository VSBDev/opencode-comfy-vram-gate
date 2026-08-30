import { requestJson, waitFor } from "./http.js"
import { GpuLockManager } from "./lock.js"

export class GateError extends Error {
  constructor(message, { cause, phase } = {}) {
    super(message, { cause })
    this.name = "GateError"
    this.phase = phase
  }
}

function loadedModelNames(payload) {
  return (payload?.models || []).map((item) => item?.name || item?.model).filter(Boolean)
}

export class VramGate {
  constructor(config, { request = requestJson, lockManager } = {}) {
    this.config = config
    this.request = request
    this.lock = lockManager || new GpuLockManager({
      lockPath: config.lock.path,
      acquireTimeoutSeconds: config.lock.acquireTimeoutSeconds,
      staleAfterSeconds: config.lock.staleAfterSeconds,
      heartbeatMs: config.lock.heartbeatMs,
      pollMs: Math.min(config.timeouts.pollMs, 500),
    })
  }

  endpoint(base, route) {
    return `${base}${route}`
  }

  async ollamaModels() {
    const payload = await this.request("GET", this.endpoint(this.config.ollama.url, "/api/ps"), {
      timeoutMs: this.config.timeouts.requestMs,
    })
    return loadedModelNames(payload)
  }

  targetOllamaModels(loaded) {
    if (this.config.ollama.unloadPolicy === "all") return loaded
    const allowlist = new Set(this.config.ollama.models)
    return loaded.filter((model) => allowlist.has(model))
  }

  async unloadOllama() {
    const targets = this.targetOllamaModels(await this.ollamaModels())
    for (const model of targets) {
      await this.request("POST", this.endpoint(this.config.ollama.url, "/api/generate"), {
        body: { model, keep_alive: 0, stream: false },
        timeoutMs: this.config.timeouts.requestMs,
      })
    }
    if (targets.length) {
      const targetSet = new Set(targets)
      await waitFor("Ollama models to unload", async () => {
        const remaining = await this.ollamaModels()
        return !remaining.some((model) => targetSet.has(model))
      }, {
        timeoutMs: this.config.timeouts.handoffSeconds * 1000,
        pollMs: this.config.timeouts.pollMs,
      })
    }
    return targets
  }

  async comfyQueue() {
    return await this.request("GET", this.endpoint(this.config.comfy.url, "/queue"), {
      timeoutMs: this.config.timeouts.requestMs,
    }) || {}
  }

  queueCounts(queue) {
    return {
      running: (queue?.queue_running || []).length,
      pending: (queue?.queue_pending || []).length,
    }
  }

  async requireComfyIdle() {
    const counts = this.queueCounts(await this.comfyQueue())
    if (counts.running || counts.pending) {
      throw new GateError(`ComfyUI is busy (${counts.running} running, ${counts.pending} pending); refusing to interrupt it`, { phase: "preflight" })
    }
    return counts
  }

  async waitForComfyIdle() {
    await waitFor("ComfyUI queue to drain", async () => {
      const counts = this.queueCounts(await this.comfyQueue())
      return counts.running === 0 && counts.pending === 0
    }, {
      timeoutMs: this.config.timeouts.renderSeconds * 1000,
      pollMs: this.config.timeouts.pollMs,
    })
  }

  async comfyStats() {
    return await this.request("GET", this.endpoint(this.config.comfy.url, "/system_stats"), {
      timeoutMs: this.config.timeouts.requestMs,
    }) || {}
  }

  primaryDevice(stats) {
    const device = stats?.devices?.[0]
    if (!device) throw new GateError("ComfyUI system_stats returned no GPU devices", { phase: "inspect" })
    return device
  }

  freeTargetMiB(device) {
    if (this.config.gpu.minimumFreeMiB !== null) return Math.round(this.config.gpu.minimumFreeMiB)
    const totalMiB = Number(device.vram_total || 0) / (1024 * 1024)
    if (!(totalMiB > 0)) throw new GateError("ComfyUI did not report total VRAM", { phase: "inspect" })
    return Math.floor(totalMiB * this.config.gpu.minimumFreeRatio)
  }

  async comfyFreeMiB() {
    const device = this.primaryDevice(await this.comfyStats())
    return Math.floor(Number(device.vram_free || 0) / (1024 * 1024))
  }

  async freeComfy() {
    await this.requireComfyIdle()
    const initialDevice = this.primaryDevice(await this.comfyStats())
    const targetMiB = this.freeTargetMiB(initialDevice)
    await this.request("POST", this.endpoint(this.config.comfy.url, "/free"), {
      body: { unload_models: true, free_memory: true },
      timeoutMs: this.config.timeouts.requestMs,
    })
    let freeMiB = 0
    await waitFor(`ComfyUI to report at least ${targetMiB} MiB free VRAM`, async () => {
      const counts = this.queueCounts(await this.comfyQueue())
      if (counts.running || counts.pending) return false
      freeMiB = await this.comfyFreeMiB()
      return freeMiB >= targetMiB
    }, {
      timeoutMs: this.config.timeouts.handoffSeconds * 1000,
      pollMs: this.config.timeouts.pollMs,
    })
    return { freeMiB, targetMiB }
  }

  async status() {
    const [models, queue, stats, owner] = await Promise.all([
      this.ollamaModels(),
      this.comfyQueue(),
      this.comfyStats(),
      this.lock.owner(),
    ])
    const device = this.primaryDevice(stats)
    return {
      ollamaModels: models,
      comfyQueue: this.queueCounts(queue),
      gpu: {
        name: device.name,
        totalMiB: Math.floor(Number(device.vram_total || 0) / (1024 * 1024)),
        freeMiB: Math.floor(Number(device.vram_free || 0) / (1024 * 1024)),
        targetFreeMiB: this.freeTargetMiB(device),
      },
      leaseOwner: owner,
    }
  }

  async before(metadata = {}) {
    const lease = await this.lock.acquire(metadata)
    try {
      await this.requireComfyIdle()
      const unloadedOllamaModels = await this.unloadOllama()
      const memory = await this.freeComfy()
      return {
        lease,
        detail: {
          phase: "before",
          unloadedOllamaModels,
          ...memory,
          lease: lease.owner,
        },
      }
    } catch (error) {
      await lease.release().catch(() => {})
      throw new GateError(`GPU handoff failed before ComfyUI execution: ${error?.message || error}`, { cause: error, phase: "before" })
    }
  }

  /**
   * Acquire the shared GPU for a local consumer other than ComfyUI.
   *
   * Preparation is deliberately identical to the ComfyUI handoff: the
   * exclusive lease is acquired first, ComfyUI must be idle, Ollama is
   * unloaded, and ComfyUI releases any resident models. The caller owns the
   * lease until afterConsumer() or recoverConsumer() completes.
   */
  async beforeConsumer(metadata = {}) {
    const lease = await this.lock.acquire({ target: "local-consumer", ...metadata })
    try {
      await this.requireComfyIdle()
      const unloadedOllamaModels = await this.unloadOllama()
      const memory = await this.freeComfy()
      return {
        lease,
        detail: {
          phase: "before-consumer",
          unloadedOllamaModels,
          ...memory,
          lease: lease.owner,
        },
      }
    } catch (error) {
      await lease.release().catch(() => {})
      throw new GateError(`GPU handoff failed before local consumer execution: ${error?.message || error}`, { cause: error, phase: "before-consumer" })
    }
  }

  async after(lease) {
    try {
      // Do not trust a tool transport returning to mean that its queued job is
      // finished. Keeping this hook open prevents the next Ollama turn from
      // reloading beside an active ComfyUI render.
      await this.waitForComfyIdle()
      const memory = await this.freeComfy()
      await lease?.release()
      return { phase: "after", ...memory }
    } catch (error) {
      throw new GateError(`GPU handback failed after ComfyUI execution: ${error?.message || error}`, { cause: error, phase: "after" })
    }
  }

  /**
   * Release a non-Comfy GPU consumer while the shared lease is still held.
   * releaseConsumer must resolve only after that consumer has unloaded its
   * models. The ComfyUI system endpoint then provides the common free-VRAM
   * verification used by every consumer of this gate.
   */
  async afterConsumer(lease, { releaseConsumer, waitForConsumerIdle, label = "local consumer" } = {}) {
    if (typeof releaseConsumer !== "function") {
      throw new GateError("releaseConsumer must be a function", { phase: "after-consumer" })
    }
    try {
      await waitForConsumerIdle?.()
      const consumer = await releaseConsumer()
      const unloadedOllamaModels = await this.unloadOllama()
      const memory = await this.freeComfy()
      await lease?.release()
      return { phase: "after-consumer", label, consumer, unloadedOllamaModels, ...memory }
    } catch (error) {
      throw new GateError(`GPU handback failed after ${label} execution: ${error?.message || error}`, { cause: error, phase: "after-consumer" })
    }
  }

  async recoverConsumer(lease, { releaseConsumer, waitForConsumerIdle, label = "local consumer" } = {}) {
    try {
      await waitForConsumerIdle?.()
      const consumer = typeof releaseConsumer === "function" ? await releaseConsumer() : undefined
      const unloadedOllamaModels = await this.unloadOllama()
      const memory = await this.freeComfy()
      return { phase: "consumer-recovery", label, consumer, unloadedOllamaModels, ...memory }
    } finally {
      await lease?.release().catch(() => {})
    }
  }

  async recover(lease) {
    try {
      await this.waitForComfyIdle()
      // A failed tool can let OpenCode start its next model turn before the
      // recovery event is delivered. Unload that newly resident model again so
      // cleanup can reach the same verified free-VRAM target as a normal handoff.
      const unloadedOllamaModels = await this.unloadOllama()
      const memory = await this.freeComfy()
      return { phase: "recovery", unloadedOllamaModels, ...memory }
    } finally {
      await lease?.release().catch(() => {})
    }
  }
}
