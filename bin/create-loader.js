#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

function usage() {
  return `Usage: opencode-comfy-vram-gate-loader TARGET

Create a zero-dependency OpenCode plugin loader at TARGET.
The command refuses to overwrite an existing file.
`
}

const targetArg = process.argv[2]
if (!targetArg || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage())
  process.exit(targetArg ? 0 : 1)
}

const target = path.resolve(targetArg)
const pluginUrl = new URL("../src/plugin.js", import.meta.url).href
const contents = `export { ComfyVramGate } from ${JSON.stringify(pluginUrl)}\n`

try {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o644 })
  console.log(`Created ${target}`)
  console.log(`Loader target: ${pluginUrl}`)
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error(`Refusing to overwrite existing file: ${target}`)
    process.exit(2)
  }
  throw error
}
