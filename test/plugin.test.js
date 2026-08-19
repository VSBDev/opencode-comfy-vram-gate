import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js"
import { createHooks } from "../src/plugin.js"

function harness() {
  const calls = []
  const lease = { id: "lease-1" }
  const gate = {
    async before(metadata) { calls.push(["before", metadata]); return { lease, detail: { ok: true } } },
    async after(value) { calls.push(["after", value]); return { ok: true } },
    async recover(value) { calls.push(["recover", value]); return { ok: true } },
  }
  const staging = {
    async beforeUpload() { return false },
    async afterUpload() { return [] },
    async cleanup() { return { removed: [], errors: [] } },
  }
  const config = mergeConfig(DEFAULT_CONFIG, { timeouts: { renderSeconds: 777 } })
  return { calls, lease, hooks: createHooks({ config, gate, staging }) }
}

test("heavy MCP calls are made blocking and bracketed by one GPU lease", async () => {
  const { hooks, calls, lease } = harness()
  const input = { tool: "mcp__comfy__comfy-local-run-workflow", sessionID: "s1", callID: "c1" }
  const output = { args: { wait: false, timeout_seconds: 10 } }

  await hooks["tool.execute.before"](input, output)
  assert.equal(output.args.wait, true)
  assert.equal(output.args.timeout_seconds, 777)
  assert.deepEqual(calls[0], ["before", { sessionID: "s1", callID: "c1", tool: input.tool }])

  await hooks["tool.execute.after"](input, { output: "done" })
  assert.deepEqual(calls[1], ["after", lease])
})

test("session idle recovers an orphaned lease when an after hook is missed", async () => {
  const { hooks, calls, lease } = harness()
  const input = { tool: "comfy_local_generate_image", sessionID: "s1", callID: "c1" }
  await hooks["tool.execute.before"](input, { args: {} })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.deepEqual(calls[1], ["recover", lease])
})
