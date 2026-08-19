import { readdir, unlink } from "node:fs/promises"
import path from "node:path"

function normalizeTool(name) {
  return String(name || "").replaceAll("-", "_")
}

function parseJson(value) {
  if (value && typeof value === "object") return value
  try {
    return JSON.parse(String(value || ""))
  } catch {
    return null
  }
}

async function listFiles(root) {
  const found = new Set()
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) found.add(path.resolve(target))
    }
  }
  await visit(root)
  return found
}

export class StagingTracker {
  constructor(config) {
    this.config = config
    this.uploadSnapshots = new Map()
    this.sessionTargets = new Map()
  }

  enabled() {
    return this.config.staging.enabled
  }

  isUploadTool(tool) {
    return normalizeTool(tool).endsWith(this.config.plugin.uploadToolSuffix)
  }

  isGeneratedOutput(sourcePath) {
    const normalized = String(sourcePath || "").replaceAll("\\", "/")
    return this.config.staging.generatedOutputRoots.some((root) => normalized.startsWith(root))
  }

  resolveTarget(upload) {
    if (upload?.type !== "input" || !upload?.cloud_name) return null
    const root = path.resolve(this.config.staging.hostInputRoot)
    const target = path.resolve(root, String(upload.subfolder || ""), String(upload.cloud_name))
    if (target === root || !target.startsWith(`${root}${path.sep}`)) return null
    return target
  }

  async beforeUpload(input, output) {
    if (!this.enabled() || !this.isUploadTool(input.tool)) return false
    const sources = Array.isArray(output.args?.paths) ? output.args.paths.filter((item) => this.isGeneratedOutput(item)) : []
    if (!sources.length) return false
    output.args.overwrite = false
    this.uploadSnapshots.set(input.callID, {
      sessionID: input.sessionID,
      existing: await listFiles(this.config.staging.hostInputRoot),
    })
    return true
  }

  async afterUpload(input, output) {
    if (!this.enabled() || !this.isUploadTool(input.tool)) return []
    const snapshot = this.uploadSnapshots.get(input.callID)
    this.uploadSnapshots.delete(input.callID)
    if (!snapshot) return []
    const payload = parseJson(output?.output)
    const uploads = Array.isArray(payload?.uploads) ? payload.uploads : []
    const targets = uploads
      .filter((upload) => this.isGeneratedOutput(upload?.local_path))
      .map((upload) => this.resolveTarget(upload))
      .filter((target) => target && !snapshot.existing.has(target))
    if (!targets.length) return []
    const sessionTargets = this.sessionTargets.get(snapshot.sessionID) || new Set()
    targets.forEach((target) => sessionTargets.add(target))
    this.sessionTargets.set(snapshot.sessionID, sessionTargets)
    return targets
  }

  async cleanup(sessionID) {
    const targets = this.sessionTargets.get(sessionID)
    if (!targets?.size) return { removed: [], errors: [] }
    this.sessionTargets.delete(sessionID)
    const removed = []
    const errors = []
    for (const target of targets) {
      try {
        await unlink(target)
        removed.push(target)
      } catch (error) {
        if (error?.code !== "ENOENT") errors.push(`${target}: ${error?.message || error}`)
      }
    }
    return { removed, errors }
  }
}
