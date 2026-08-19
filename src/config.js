import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url))

export const DEFAULT_CONFIG = Object.freeze({
  ollama: {
    url: "http://127.0.0.1:11434",
    unloadPolicy: "all",
    models: [],
  },
  comfy: {
    url: "http://127.0.0.1:8188",
  },
  gpu: {
    minimumFreeMiB: null,
    minimumFreeRatio: 0.85,
  },
  timeouts: {
    requestMs: 15_000,
    handoffSeconds: 120,
    renderSeconds: 3_600,
    pollMs: 500,
  },
  lock: {
    path: path.join(tmpdir(), "opencode-comfy-vram-gate", "gpu-0.lock"),
    acquireTimeoutSeconds: 120,
    staleAfterSeconds: 7_200,
    heartbeatMs: 5_000,
  },
  plugin: {
    forceBlocking: true,
    heavyToolSuffixes: [
      "comfy_local_run_workflow",
      "comfy_local_run_template",
      "comfy_local_generate_image",
      "comfy_local_vary_workflow"
    ],
    uploadToolSuffix: "comfy_local_upload_file",
  },
  staging: {
    enabled: false,
    hostInputRoot: null,
    generatedOutputRoots: [],
  },
})

function clone(value) {
  return structuredClone(value)
}

function merge(base, overlay) {
  const result = clone(base)
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value)
    } else {
      result[key] = clone(value)
    }
  }
  return result
}

function bool(value, name) {
  if (typeof value === "boolean") return value
  if (/^(1|true|yes|on)$/i.test(String(value))) return true
  if (/^(0|false|no|off)$/i.test(String(value))) return false
  throw new Error(`${name} must be true or false`)
}

function number(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`)
  return parsed
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return String(value || "").split(/[,;]/).map((item) => item.trim()).filter(Boolean)
}

function trimUrl(value, name) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw new Error(`${name} must be an absolute HTTP URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http or https`)
  return parsed.toString().replace(/\/$/, "")
}

async function readJson(filePath, { required = false } = {}) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null
    throw new Error(`Cannot load config ${filePath}: ${error?.message || error}`)
  }
}

export function parseEnv(source, label = ".env") {
  const parsed = {}
  for (const [index, original] of String(source).split(/\r?\n/).entries()) {
    let line = original.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice(7).trimStart()
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`Invalid ${label} entry at line ${index + 1}`)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0]
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd()
    }
    parsed[match[1]] = value
  }
  return parsed
}

async function readEnv(filePath, { required = false } = {}) {
  try {
    return parseEnv(await readFile(filePath, "utf8"), filePath)
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null
    throw new Error(`Cannot load environment ${filePath}: ${error?.message || error}`)
  }
}

function environmentOverlay(env) {
  const out = {}
  const set = (section, key, value) => {
    if (value === undefined) return
    out[section] ||= {}
    out[section][key] = value
  }

  set("ollama", "url", env.OCVRAM_OLLAMA_URL)
  set("ollama", "unloadPolicy", env.OCVRAM_OLLAMA_UNLOAD_POLICY)
  if (env.OCVRAM_OLLAMA_MODELS !== undefined) set("ollama", "models", list(env.OCVRAM_OLLAMA_MODELS))
  set("comfy", "url", env.OCVRAM_COMFY_URL)
  if (env.OCVRAM_MIN_FREE_MIB !== undefined) set("gpu", "minimumFreeMiB", number(env.OCVRAM_MIN_FREE_MIB, "OCVRAM_MIN_FREE_MIB"))
  if (env.OCVRAM_MIN_FREE_RATIO !== undefined) set("gpu", "minimumFreeRatio", number(env.OCVRAM_MIN_FREE_RATIO, "OCVRAM_MIN_FREE_RATIO"))
  if (env.OCVRAM_REQUEST_TIMEOUT_MS !== undefined) set("timeouts", "requestMs", number(env.OCVRAM_REQUEST_TIMEOUT_MS, "OCVRAM_REQUEST_TIMEOUT_MS"))
  if (env.OCVRAM_HANDOFF_TIMEOUT_SECONDS !== undefined) set("timeouts", "handoffSeconds", number(env.OCVRAM_HANDOFF_TIMEOUT_SECONDS, "OCVRAM_HANDOFF_TIMEOUT_SECONDS"))
  if (env.OCVRAM_RENDER_TIMEOUT_SECONDS !== undefined) set("timeouts", "renderSeconds", number(env.OCVRAM_RENDER_TIMEOUT_SECONDS, "OCVRAM_RENDER_TIMEOUT_SECONDS"))
  if (env.OCVRAM_POLL_MS !== undefined) set("timeouts", "pollMs", number(env.OCVRAM_POLL_MS, "OCVRAM_POLL_MS"))
  set("lock", "path", env.OCVRAM_LOCK_PATH)
  if (env.OCVRAM_LOCK_TIMEOUT_SECONDS !== undefined) set("lock", "acquireTimeoutSeconds", number(env.OCVRAM_LOCK_TIMEOUT_SECONDS, "OCVRAM_LOCK_TIMEOUT_SECONDS"))
  if (env.OCVRAM_LOCK_STALE_SECONDS !== undefined) set("lock", "staleAfterSeconds", number(env.OCVRAM_LOCK_STALE_SECONDS, "OCVRAM_LOCK_STALE_SECONDS"))
  if (env.OCVRAM_LOCK_HEARTBEAT_MS !== undefined) set("lock", "heartbeatMs", number(env.OCVRAM_LOCK_HEARTBEAT_MS, "OCVRAM_LOCK_HEARTBEAT_MS"))
  if (env.OCVRAM_FORCE_BLOCKING !== undefined) set("plugin", "forceBlocking", bool(env.OCVRAM_FORCE_BLOCKING, "OCVRAM_FORCE_BLOCKING"))
  if (env.OCVRAM_HEAVY_TOOL_SUFFIXES !== undefined) set("plugin", "heavyToolSuffixes", list(env.OCVRAM_HEAVY_TOOL_SUFFIXES))
  set("plugin", "uploadToolSuffix", env.OCVRAM_UPLOAD_TOOL_SUFFIX)
  if (env.OCVRAM_STAGING_CLEANUP !== undefined) set("staging", "enabled", bool(env.OCVRAM_STAGING_CLEANUP, "OCVRAM_STAGING_CLEANUP"))
  set("staging", "hostInputRoot", env.OCVRAM_HOST_INPUT_ROOT)
  if (env.OCVRAM_GENERATED_OUTPUT_ROOTS !== undefined) set("staging", "generatedOutputRoots", list(env.OCVRAM_GENERATED_OUTPUT_ROOTS))
  return out
}

export function validateConfig(input) {
  const config = clone(input)
  config.ollama.url = trimUrl(config.ollama.url, "ollama.url")
  config.comfy.url = trimUrl(config.comfy.url, "comfy.url")
  if (!['all', 'listed'].includes(config.ollama.unloadPolicy)) throw new Error("ollama.unloadPolicy must be 'all' or 'listed'")
  if (!Array.isArray(config.ollama.models)) throw new Error("ollama.models must be an array")
  if (config.ollama.models.some((item) => typeof item !== "string" || !item)) throw new Error("ollama.models must contain non-empty strings")
  if (config.ollama.unloadPolicy === "listed" && config.ollama.models.length === 0) throw new Error("ollama.models cannot be empty when unloadPolicy is 'listed'")
  if (config.gpu.minimumFreeMiB !== null && config.gpu.minimumFreeMiB < 0) throw new Error("gpu.minimumFreeMiB must be null or non-negative")
  if (!(config.gpu.minimumFreeRatio > 0 && config.gpu.minimumFreeRatio <= 1)) throw new Error("gpu.minimumFreeRatio must be greater than 0 and at most 1")
  for (const [name, value] of Object.entries(config.timeouts)) {
    if (!(Number(value) > 0)) throw new Error(`timeouts.${name} must be greater than 0`)
  }
  for (const key of ["acquireTimeoutSeconds", "staleAfterSeconds", "heartbeatMs"]) {
    if (!(Number(config.lock[key]) > 0)) throw new Error(`lock.${key} must be greater than 0`)
  }
  if (typeof config.lock.path !== "string" || !config.lock.path) throw new Error("lock.path must be a non-empty path")
  config.lock.path = path.resolve(config.lock.path)
  if (!Array.isArray(config.plugin.heavyToolSuffixes) || !config.plugin.heavyToolSuffixes.length) throw new Error("plugin.heavyToolSuffixes must be a non-empty array")
  if (config.plugin.heavyToolSuffixes.some((item) => typeof item !== "string" || !item)) throw new Error("plugin.heavyToolSuffixes must contain non-empty strings")
  if (typeof config.plugin.uploadToolSuffix !== "string" || !config.plugin.uploadToolSuffix) throw new Error("plugin.uploadToolSuffix must be a non-empty string")
  if (typeof config.plugin.forceBlocking !== "boolean") throw new Error("plugin.forceBlocking must be true or false")
  if (typeof config.staging.enabled !== "boolean") throw new Error("staging.enabled must be true or false")
  if (config.staging.enabled) {
    if (!config.staging.hostInputRoot) throw new Error("staging.hostInputRoot is required when staging cleanup is enabled")
    if (!Array.isArray(config.staging.generatedOutputRoots) || !config.staging.generatedOutputRoots.length) throw new Error("staging.generatedOutputRoots is required when staging cleanup is enabled")
    config.staging.hostInputRoot = path.resolve(config.staging.hostInputRoot)
    config.staging.generatedOutputRoots = config.staging.generatedOutputRoots.map((item) => String(item).replaceAll("\\", "/").replace(/\/?$/, "/"))
  }
  return config
}

export async function loadConfig({ directory = process.cwd(), env = process.env, explicitPath, dotenvPaths, jsonPaths } = {}) {
  let config = clone(DEFAULT_CONFIG)
  const globalPath = path.join(homedir(), ".config", "opencode", "comfy-vram-gate.json")
  const projectPath = path.join(directory, ".opencode", "comfy-vram-gate.json")
  for (const candidate of jsonPaths ?? [globalPath, projectPath]) {
    const data = await readJson(candidate)
    if (data) config = merge(config, data)
  }
  const resolvedEnv = {}
  const defaultDotenvPaths = [
    PACKAGE_ENV_PATH,
    path.join(homedir(), ".config", "opencode", "comfy-vram-gate.env"),
    path.join(directory, ".opencode", "comfy-vram-gate.env"),
  ]
  for (const candidate of dotenvPaths ?? defaultDotenvPaths) {
    const data = await readEnv(candidate)
    if (data) Object.assign(resolvedEnv, data)
  }
  if (env.OCVRAM_DOTENV) Object.assign(resolvedEnv, await readEnv(path.resolve(env.OCVRAM_DOTENV), { required: true }))
  Object.assign(resolvedEnv, env)

  const selectedExplicitPath = explicitPath || resolvedEnv.OCVRAM_CONFIG
  if (selectedExplicitPath) config = merge(config, await readJson(path.resolve(selectedExplicitPath), { required: true }))
  config = merge(config, environmentOverlay(resolvedEnv))
  return validateConfig(config)
}

export function mergeConfig(base, overlay) {
  return validateConfig(merge(base, overlay))
}
