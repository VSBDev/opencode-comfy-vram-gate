#!/usr/bin/env node
import { loadConfig } from "../src/config.js"
import { VramGate } from "../src/gate.js"

function usage() {
  return `Usage: opencode-comfy-vram-gate <command> [options]

Commands:
  status          Show Ollama, ComfyUI, GPU, and lease state (read-only)
  doctor          Validate configuration and service connectivity (read-only)
  print-config    Print the resolved configuration
  handoff-test    Describe the handoff; add --execute to perform it

Options:
  --config PATH   Load an explicit JSON configuration file
  --execute       Required to mutate VRAM during handoff-test
  --help          Show this help
`
}

const args = process.argv.slice(2)
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(usage())
  process.exit(args.length ? 0 : 1)
}
const command = args[0]
const configIndex = args.indexOf("--config")
const explicitPath = configIndex >= 0 ? args[configIndex + 1] : undefined
if (configIndex >= 0 && !explicitPath) throw new Error("--config requires a path")

const config = await loadConfig({ explicitPath })
const gate = new VramGate(config)

if (command === "print-config") {
  console.log(JSON.stringify(config, null, 2))
} else if (command === "status") {
  console.log(JSON.stringify(await gate.status(), null, 2))
} else if (command === "doctor") {
  const status = await gate.status()
  console.log(JSON.stringify({ ok: true, config, status }, null, 2))
} else if (command === "handoff-test") {
  if (!args.includes("--execute")) {
    console.log(JSON.stringify({
      execute: false,
      message: "Dry run only. Re-run with --execute to unload configured Ollama models, free ComfyUI, and immediately hand the GPU back.",
      status: await gate.status(),
    }, null, 2))
  } else {
    const handoff = await gate.before({ source: "cli-handoff-test" })
    const handback = await gate.after(handoff.lease)
    console.log(JSON.stringify({ ok: true, handoff: handoff.detail, handback }, null, 2))
  }
} else {
  console.error(`Unknown command: ${command}\n`)
  console.error(usage())
  process.exit(1)
}
