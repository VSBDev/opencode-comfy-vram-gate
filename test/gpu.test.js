import test from "node:test"
import assert from "node:assert/strict"
import { inspectNvidiaGpu } from "../src/gpu.js"

test("nvidia-smi inspection returns normalized MiB without invoking a shell", async () => {
  let invocation
  const result = await inspectNvidiaGpu({
    deviceIndex: 2,
    execute: async (...args) => {
      invocation = args
      return { stdout: "NVIDIA Test GPU, 32768, 30123\n" }
    },
  })

  assert.equal(invocation[0], "nvidia-smi")
  assert.deepEqual(invocation[1], ["--id=2", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
  assert.deepEqual(result, {
    backend: "nvidia-smi",
    deviceIndex: 2,
    name: "NVIDIA Test GPU",
    totalMiB: 32_768,
    freeMiB: 30_123,
  })
})

test("nvidia-smi inspection rejects malformed output", async () => {
  await assert.rejects(
    () => inspectNvidiaGpu({ execute: async () => ({ stdout: "not memory data" }) }),
    /invalid GPU memory data/,
  )
})
