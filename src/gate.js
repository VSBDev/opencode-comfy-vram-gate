import { requestJson, waitFor } from "./http.js"
import { inspectNvidiaGpu } from "./gpu.js"
import { GpuLockManager } from "./lock.js"

const OFFLINE_CODES = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"])

function errorMessage(error) {
  return error?.message || String(error)
}

function isPeerOffline(error) {
  let current = error
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (OFFLINE_CODES.has(current.code)) return true
    current = current.cause
  }
  return false
}

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
  constructor(config, { request = requestJson, lockManager, inspectGpu } = {}) {
    this.config = config
    this.request = request
    this.inspectGpu = inspectGpu || (() => inspectNvidiaGpu({
      deviceIndex: config.gpu.deviceIndex,
      timeoutMs: config.timeouts.requestMs,
    }))
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

  async unloadOllamaForConsumer() {
    try {
      return { available: true, unloadedOllamaModels: await this.unloadOllama() }
    } catch (error) {
      if (!isPeerOffline(error)) throw error
      return { available: false, unloadedOllamaModels: [], error: errorMessage(error) }
    }
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

  async comfyConsumerPreflight() {
    try {
      const queue = this.queueCounts(await this.comfyQueue())
      if (queue.running || queue.pending) {
        throw new GateError(`ComfyUI is busy (${queue.running} running, ${queue.pending} pending); refusing to interrupt it`, { phase: "preflight" })
      }
      return { available: true, queue }
    } catch (error) {
      if (!isPeerOffline(error)) throw error
      return { available: false, queue: null, released: false, error: errorMessage(error) }
    }
  }

  async freeComfyForConsumer(preflight) {
    if (!preflight.available) return preflight
    try {
      const queue = await this.requireComfyIdle()
      await this.request("POST", this.endpoint(this.config.comfy.url, "/free"), {
        body: { unload_models: true, free_memory: true },
        timeoutMs: this.config.timeouts.requestMs,
      })
      return { available: true, queue, released: true }
    } catch (error) {
      if (!isPeerOffline(error)) throw error
      return { available: false, queue: null, released: false, error: errorMessage(error) }
    }
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

  totalMiB(device) {
    const direct = Number(device?.totalMiB)
    if (direct > 0) return Math.floor(direct)
    const bytes = Number(device?.vram_total)
    if (bytes > 0) return Math.floor(bytes / (1024 * 1024))
    throw new GateError("GPU memory probe did not report total VRAM", { phase: "inspect" })
  }

  freeTargetMiB(device) {
    if (this.config.gpu.minimumFreeMiB !== null) return Math.round(this.config.gpu.minimumFreeMiB)
    return Math.floor(this.totalMiB(device) * this.config.gpu.minimumFreeRatio)
  }

  requiredFreeTargetMiB(device, requiredFreeMiB) {
    if (requiredFreeMiB === undefined || requiredFreeMiB === null) return this.freeTargetMiB(device)
    const targetMiB = Number(requiredFreeMiB)
    if (!Number.isFinite(targetMiB) || targetMiB <= 0) {
      throw new GateError("requiredFreeMiB must be a positive number", { phase: "inspect" })
    }
    const totalMiB = this.totalMiB(device)
    const roundedTargetMiB = Math.ceil(targetMiB)
    if (roundedTargetMiB > totalMiB) {
      throw new GateError(`Consumer requires ${roundedTargetMiB} MiB free VRAM but the GPU reports ${totalMiB} MiB total`, { phase: "inspect" })
    }
    return roundedTargetMiB
  }

  async gpuSnapshot() {
    const snapshot = await this.inspectGpu()
    const totalMiB = this.totalMiB(snapshot)
    const freeMiB = Math.floor(Number(snapshot?.freeMiB))
    if (!Number.isFinite(freeMiB) || freeMiB < 0) {
      throw new GateError("GPU memory probe did not report free VRAM", { phase: "inspect" })
    }
    return { ...snapshot, totalMiB, freeMiB }
  }

  async waitForConsumerMemory(requiredFreeMiB) {
    let gpu = await this.gpuSnapshot()
    const targetMiB = this.requiredFreeTargetMiB(gpu, requiredFreeMiB)
    if (gpu.freeMiB < targetMiB) {
      await waitFor(`GPU probe to report at least ${targetMiB} MiB free VRAM`, async () => {
        gpu = await this.gpuSnapshot()
        return gpu.freeMiB >= targetMiB
      }, {
        timeoutMs: this.config.timeouts.handoffSeconds * 1000,
        pollMs: this.config.timeouts.pollMs,
      })
    }
    return { freeMiB: gpu.freeMiB, targetMiB, gpu }
  }

  async comfyFreeMiB() {
    const device = this.primaryDevice(await this.comfyStats())
    return Math.floor(Number(device.vram_free || 0) / (1024 * 1024))
  }

  async freeComfy({ requiredFreeMiB } = {}) {
    await this.requireComfyIdle()
    const initialDevice = this.primaryDevice(await this.comfyStats())
    const targetMiB = this.requiredFreeTargetMiB(initialDevice, requiredFreeMiB)
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

  async consumerStatus() {
    const [ollama, comfy, gpu, owner] = await Promise.all([
      this.ollamaModels().then(
        (models) => ({ available: true, models }),
        (error) => ({ available: false, models: [], error: errorMessage(error) }),
      ),
      this.comfyQueue().then(
        (queue) => ({ available: true, queue: this.queueCounts(queue) }),
        (error) => ({ available: false, queue: null, error: errorMessage(error) }),
      ),
      this.gpuSnapshot(),
      this.lock.owner(),
    ])
    return {
      ollamaModels: ollama.models,
      ollama,
      comfyQueue: comfy.queue,
      comfy,
      gpu: { ...gpu, targetFreeMiB: this.freeTargetMiB(gpu) },
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
   * The exclusive lease is acquired first. Reachable GPU peers are asked to
   * release idle models, while offline peers are not required to be running.
   * A process-level GPU probe verifies memory independently of any peer API.
   * The caller owns the lease until afterConsumer() or recoverConsumer()
   * completes.
   */
  async beforeConsumer(metadata = {}, { requiredFreeMiB } = {}) {
    const leaseMetadata = { ...metadata, target: "local-consumer" }
    if (requiredFreeMiB === undefined) delete leaseMetadata.requiredFreeMiB
    else leaseMetadata.requiredFreeMiB = requiredFreeMiB
    const lease = await this.lock.acquire(leaseMetadata)
    try {
      const comfyPreflight = await this.comfyConsumerPreflight()
      const ollama = await this.unloadOllamaForConsumer()
      const comfy = await this.freeComfyForConsumer(comfyPreflight)
      const memory = await this.waitForConsumerMemory(requiredFreeMiB)
      return {
        lease,
        detail: {
          phase: "before-consumer",
          unloadedOllamaModels: ollama.unloadedOllamaModels,
          ollama,
          comfy,
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
   * models. The process-level GPU probe then provides free-VRAM verification
   * without requiring either peer service to be online.
   */
  async afterConsumer(lease, { releaseConsumer, waitForConsumerIdle, label = "local consumer", requiredFreeMiB } = {}) {
    if (typeof releaseConsumer !== "function") {
      throw new GateError("releaseConsumer must be a function", { phase: "after-consumer" })
    }
    try {
      await waitForConsumerIdle?.()
      const consumer = await releaseConsumer()
      const comfyPreflight = await this.comfyConsumerPreflight()
      const ollama = await this.unloadOllamaForConsumer()
      const comfy = await this.freeComfyForConsumer(comfyPreflight)
      const memory = await this.waitForConsumerMemory(requiredFreeMiB ?? lease?.owner?.requiredFreeMiB)
      await lease?.release()
      return { phase: "after-consumer", label, consumer, unloadedOllamaModels: ollama.unloadedOllamaModels, ollama, comfy, ...memory }
    } catch (error) {
      throw new GateError(`GPU handback failed after ${label} execution: ${error?.message || error}`, { cause: error, phase: "after-consumer" })
    }
  }

  async recoverConsumer(lease, { releaseConsumer, waitForConsumerIdle, label = "local consumer", requiredFreeMiB } = {}) {
    try {
      await waitForConsumerIdle?.()
      const consumer = typeof releaseConsumer === "function" ? await releaseConsumer() : undefined
      const comfyPreflight = await this.comfyConsumerPreflight()
      const ollama = await this.unloadOllamaForConsumer()
      const comfy = await this.freeComfyForConsumer(comfyPreflight)
      const memory = await this.waitForConsumerMemory(requiredFreeMiB ?? lease?.owner?.requiredFreeMiB)
      return { phase: "consumer-recovery", label, consumer, unloadedOllamaModels: ollama.unloadedOllamaModels, ollama, comfy, ...memory }
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
