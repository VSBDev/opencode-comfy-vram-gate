import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))
  } catch {
    return null
  }
}

export class GpuLease {
  constructor(manager, token, owner) {
    this.manager = manager
    this.token = token
    this.owner = owner
    this.released = false
    this.releasing = false
    this.heartbeatInFlight = null
    this.timer = setInterval(() => this.heartbeat().catch(() => {}), manager.heartbeatMs)
    this.timer.unref?.()
  }

  async heartbeat() {
    if (this.released || this.releasing) return
    if (this.heartbeatInFlight) return this.heartbeatInFlight
    this.heartbeatInFlight = (async () => {
      const current = await readOwner(this.manager.lockPath)
      if (current?.token !== this.token) throw new Error("GPU lease ownership changed")
      const now = new Date().toISOString()
      this.owner.updatedAt = now
      await writeFile(path.join(this.manager.lockPath, "owner.json"), `${JSON.stringify(this.owner, null, 2)}\n`, "utf8")
    })()
    try {
      await this.heartbeatInFlight
    } finally {
      this.heartbeatInFlight = null
    }
  }

  async release() {
    if (this.released || this.releasing) return false
    this.releasing = true
    clearInterval(this.timer)
    try {
      await this.heartbeatInFlight
      const current = await readOwner(this.manager.lockPath)
      if (current?.token !== this.token) {
        this.released = true
        return false
      }
      await rm(this.manager.lockPath, { recursive: true, force: true })
      this.released = true
      return true
    } catch (error) {
      // Keep a failed release live so recovery can try again instead of
      // silently abandoning a lock whose heartbeat has stopped.
      this.timer = setInterval(() => this.heartbeat().catch(() => {}), this.manager.heartbeatMs)
      this.timer.unref?.()
      this.releasing = false
      throw error
    }
  }
}

export class GpuLockManager {
  constructor({ lockPath, acquireTimeoutSeconds, staleAfterSeconds, heartbeatMs, pollMs = 250 }) {
    this.lockPath = lockPath
    this.acquireTimeoutMs = acquireTimeoutSeconds * 1000
    this.staleAfterMs = staleAfterSeconds * 1000
    this.heartbeatMs = heartbeatMs
    this.pollMs = pollMs
  }

  async owner() {
    return readOwner(this.lockPath)
  }

  async reclaimIfStale() {
    let lockStat
    try {
      lockStat = await stat(path.join(this.lockPath, "owner.json")).catch(() => stat(this.lockPath))
    } catch (error) {
      if (error?.code === "ENOENT") return false
      throw error
    }
    const owner = await readOwner(this.lockPath)
    const sameHostDeadProcess = owner?.hostname === hostname() && !processExists(owner?.pid)
    const tooOld = Date.now() - lockStat.mtimeMs > this.staleAfterMs
    if (!sameHostDeadProcess && !tooOld) return false

    const stalePath = `${this.lockPath}.stale-${randomUUID()}`
    try {
      await rename(this.lockPath, stalePath)
    } catch (error) {
      if (error?.code === "ENOENT") return false
      throw error
    }
    await rm(stalePath, { recursive: true, force: true })
    return true
  }

  async acquire(metadata = {}) {
    const deadline = Date.now() + this.acquireTimeoutMs
    await mkdir(path.dirname(this.lockPath), { recursive: true })
    while (Date.now() < deadline) {
      const token = randomUUID()
      try {
        await mkdir(this.lockPath)
        const now = new Date().toISOString()
        const owner = {
          token,
          pid: process.pid,
          hostname: hostname(),
          startedAt: now,
          updatedAt: now,
          ...metadata,
        }
        await writeFile(path.join(this.lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8")
        return new GpuLease(this, token, owner)
      } catch (error) {
        if (error?.code !== "EEXIST") throw error
      }
      await this.reclaimIfStale()
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
    const owner = await this.owner()
    throw new Error(`Timed out acquiring GPU lease at ${this.lockPath}${owner ? `; owner=${JSON.stringify(owner)}` : ""}`)
  }
}
