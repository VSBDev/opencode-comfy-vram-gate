import { loadConfig } from "./config.js"
import { VramGate } from "./gate.js"
import { StagingTracker } from "./staging.js"

function normalizeTool(name) {
  return String(name || "").replaceAll("-", "_")
}

function sessionIDFromEvent(event) {
  return event?.properties?.sessionID || event?.data?.sessionID
}

async function safeLog(client, level, message, extra = {}) {
  try {
    await client?.app?.log?.({
      body: { service: "opencode-comfy-vram-gate", level, message, extra },
    })
  } catch {
    // Logging must never break the GPU handoff.
  }
}

export function createHooks({ config, client, gate = new VramGate(config), staging = new StagingTracker(config) }) {
  const leases = new Map()

  const isHeavyTool = (tool) => {
    const normalized = normalizeTool(tool)
    return config.plugin.heavyToolSuffixes.some((suffix) => normalized.endsWith(suffix))
  }

  async function recoverSession(sessionID) {
    const entries = [...leases.entries()].filter(([, item]) => item.sessionID === sessionID)
    for (const [callID, item] of entries) {
      try {
        const detail = await gate.recover(item.lease)
        await safeLog(client, "warn", "Recovered an orphaned GPU handoff", { callID, detail })
      } catch (error) {
        await safeLog(client, "error", "Failed to recover an orphaned GPU handoff", { callID, error: error?.message || String(error) })
      } finally {
        leases.delete(callID)
      }
    }
  }

  return {
    event: async ({ event }) => {
      if (!["session.idle", "session.error", "session.deleted"].includes(event?.type)) return
      const sessionID = sessionIDFromEvent(event)
      if (!sessionID) return
      await recoverSession(sessionID)
      const cleanup = await staging.cleanup(sessionID)
      if (cleanup.removed.length || cleanup.errors.length) {
        await safeLog(client, cleanup.errors.length ? "warn" : "info", "Temporary ComfyUI input cleanup finished", cleanup)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (await staging.beforeUpload(input, output)) return
      if (!isHeavyTool(input.tool)) return
      if (config.plugin.forceBlocking) {
        output.args.wait = true
        output.args.timeout_seconds = Math.max(Number(output.args.timeout_seconds || 0), config.timeouts.renderSeconds)
      }
      const handoff = await gate.before({
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
      })
      leases.set(input.callID, { lease: handoff.lease, sessionID: input.sessionID })
      await safeLog(client, "info", "GPU handed to ComfyUI", handoff.detail)
    },

    "tool.execute.after": async (input, output) => {
      const staged = await staging.afterUpload(input, output)
      if (staged.length) {
        await safeLog(client, "info", "Generated outputs staged as temporary ComfyUI inputs", { targets: staged })
        return
      }
      if (!isHeavyTool(input.tool)) return
      const item = leases.get(input.callID)
      if (!item) {
        await safeLog(client, "warn", "ComfyUI tool completed without a matching GPU lease", { callID: input.callID, tool: input.tool })
        return
      }
      const detail = await gate.after(item.lease)
      leases.delete(input.callID)
      await safeLog(client, "info", "GPU released for Ollama", detail)
    },
  }
}

export const ComfyVramGate = async ({ client, directory }) => {
  const config = await loadConfig({ directory })
  return createHooks({ config, client })
}
