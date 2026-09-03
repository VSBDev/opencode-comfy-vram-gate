import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function inspectNvidiaGpu({ deviceIndex = 0, timeoutMs = 15_000, execute = execFileAsync } = {}) {
  let stdout
  try {
    ({ stdout } = await execute("nvidia-smi", [
      `--id=${deviceIndex}`,
      "--query-gpu=name,memory.total,memory.free",
      "--format=csv,noheader,nounits",
    ], { timeout: timeoutMs, windowsHide: true }))
  } catch (error) {
    throw new Error(`Cannot inspect GPU memory with nvidia-smi: ${error?.message || error}`, { cause: error })
  }

  const line = String(stdout || "").trim().split(/\r?\n/, 1)[0]
  const fields = line.split(",").map((field) => field.trim())
  const freeMiB = Number(fields.pop())
  const totalMiB = Number(fields.pop())
  const name = fields.join(", ")
  if (!name || !(totalMiB > 0) || !Number.isFinite(freeMiB) || freeMiB < 0) {
    throw new Error(`nvidia-smi returned invalid GPU memory data: ${line || "<empty>"}`)
  }
  return { backend: "nvidia-smi", deviceIndex, name, totalMiB: Math.floor(totalMiB), freeMiB: Math.floor(freeMiB) }
}
