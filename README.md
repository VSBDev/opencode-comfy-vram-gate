# OpenCode Comfy VRAM Gate

An OpenCode plugin that safely hands one GPU back and forth between Ollama and a local ComfyUI server.

The common failure mode is simple: OpenCode loads a large local model through Ollama, then asks ComfyUI to run another large model on the same GPU. Both allocations overlap and the render fails. This plugin makes the handoff explicit and keeps it in place for the complete ComfyUI tool call.

## Why this exists

A fully local creative agent should be able to complete a feedback loop on one GPU:

```text
local LLM writes a prompt
        ↓
ComfyUI generates an image, video, or audio asset
        ↓
local vision-capable LLM inspects the result
        ↓
the LLM revises the prompt and iterates
```

Large language and generative-media models often cannot remain loaded together. Without orchestration, an agent can plan the render but exhaust VRAM when it invokes ComfyUI, or ComfyUI can leave too little memory for the LLM to inspect the result and continue. The gate gives each stage temporary ownership of the GPU, making multi-step local workflows practical on a single card.

The mechanism is model-agnostic: ComfyUI may run Krea, LTX, MiniMax, or any other configured workflow, and Ollama may serve any suitable text or vision model. The plugin does not choose models, prompts, LoRAs, workflows, or iteration policy; those remain the responsibility of the user's agent instructions, skills, and MCP tools.

## What it does

For each configured heavy ComfyUI MCP tool call, the plugin:

1. Acquires an exclusive per-GPU lease.
2. Refuses to proceed if ComfyUI already has running or pending work.
3. Unloads all configured Ollama models with `keep_alive: 0` and verifies that they disappeared from `/api/ps`.
4. Calls ComfyUI's `/free` endpoint and waits for the configured amount of free VRAM.
5. Forces the MCP call to remain blocking until the render completes.
6. Frees ComfyUI's models and releases the lease. Ollama reloads normally on the next model request.

If OpenCode misses an `after` hook because a tool fails, the session recovery hook waits for ComfyUI to finish, frees its models, and releases the orphaned lease.

The lease is a heartbeat-backed atomic directory lock. It prevents two OpenCode sessions or processes on the same host from handing the same GPU to different jobs at once.

## Scope

Version 0.1 targets:

- OpenCode 1.x plugin hooks
- Ollama's HTTP API
- ComfyUI's HTTP server (`/queue`, `/system_stats`, and `/free`)
- one NVIDIA GPU shared by Ollama and ComfyUI
- host OpenCode/Ollama with ComfyUI exposed from a container

The plugin orchestrates VRAM only. Workflow choice, prompt quality, LoRA policy, vision support, reference-image handling, aspect ratio, and output naming belong in your OpenCode skills and ComfyUI MCP server.

## Compatibility

The initial release is tested and supported on Linux. The core uses portable Node.js APIs and may work on native Windows, but Windows lock recovery, configuration paths, and installation have not been validated yet. Treat Windows as experimental; WSL2 is the safer option today. macOS and unified-memory systems are outside the version 0.1 target.

| Component | Initial compatibility |
| --- | --- |
| Operating system | Linux supported; native Windows experimental |
| Node.js | 20 or newer |
| OpenCode | 1.x plugin API; tested with 1.18.18 |
| Ollama | HTTP API with `/api/ps` and `/api/generate` supporting `keep_alive: 0` |
| ComfyUI | HTTP API with `/queue`, `/system_stats`, and `/free` |
| ComfyUI MCP server | Configured heavy tools must support a blocking call contract; defaults expect `wait` and `timeout_seconds` |
| GPU topology | One discrete GPU shared by Ollama and ComfyUI |

The plugin does not depend on a particular ComfyUI MCP package version or implement MCP transport itself. It intercepts OpenCode tool hooks and matches configurable tool-name suffixes. With `plugin.forceBlocking` enabled, it adds `wait: true` and raises `timeout_seconds` to the configured render timeout. An MCP implementation that uses different argument names should disable that behavior or add a compatible adapter before use.

Optional staging cleanup has a narrower contract. Its upload tool must accept `paths` and `overwrite`, then return an `uploads` collection containing `type`, `cloud_name`, optional `subfolder`, and `local_path`. Staging cleanup is disabled by default and is not required for VRAM orchestration.

## Requirements

- Node.js 20 or newer
- OpenCode with the ComfyUI MCP tools enabled
- Ollama reachable from the OpenCode host
- ComfyUI reachable from the OpenCode host
- ComfyUI configured to expose its server API

Keep both HTTP endpoints on a trusted local network. This plugin does not add authentication to Ollama or ComfyUI.

## Install

This repository is not published to npm yet. For local development, clone it outside the OpenCode plugin directory, run its verification, and generate a tiny loader that imports its entrypoint:

```bash
export VRAM_GATE_REPOSITORY="$(pwd)"
export OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
npm run verify
node "$VRAM_GATE_REPOSITORY/bin/create-loader.js" \
  "$OPENCODE_CONFIG_DIR/plugins/comfy-vram-gate.js"
```

The loader generator refuses to overwrite an existing file. Move or back up an older plugin first; see the reversible migration below.

OpenCode automatically loads direct `.js` and `.ts` files under `~/.config/opencode/plugins/` or a project's `.opencode/plugins/`. Restart OpenCode after adding or replacing a plugin.

Do not load this plugin beside another VRAM handoff plugin. OpenCode runs every matching hook, so two gates would both try to manage the same call.

Once published to npm, it can instead be listed in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-comfy-vram-gate"]
}
```

## Configure

The plugin merges configuration in this order, with later values winning:

1. built-in defaults
2. `~/.config/opencode/comfy-vram-gate.json`
3. `<project>/.opencode/comfy-vram-gate.json`
4. the JSON file named by `OCVRAM_CONFIG`
5. the repository-local `.env`
6. `~/.config/opencode/comfy-vram-gate.env`
7. `<project>/.opencode/comfy-vram-gate.env`
8. the private file named by `OCVRAM_DOTENV`
9. process environment variables

Start with [.env.example](.env.example), copy it to `.env`, and put every machine-specific URL, filesystem path, model name, and memory threshold there. `.env` and `.env.*` are ignored by Git, except for the generic `.env.example` template. JSON remains available for shareable configuration; see [examples/basic.json](examples/basic.json).

```json
{
  "ollama": {
    "url": "http://127.0.0.1:11434",
    "unloadPolicy": "all",
    "models": []
  },
  "comfy": {
    "url": "http://127.0.0.1:8188"
  },
  "gpu": {
    "minimumFreeMiB": null,
    "minimumFreeRatio": 0.85
  },
  "timeouts": {
    "requestMs": 15000,
    "handoffSeconds": 120,
    "renderSeconds": 3600,
    "pollMs": 500
  },
  "lock": {
    "path": "/tmp/opencode-comfy-vram-gate/gpu-0.lock",
    "acquireTimeoutSeconds": 120,
    "staleAfterSeconds": 7200,
    "heartbeatMs": 5000
  },
  "plugin": {
    "forceBlocking": true,
    "heavyToolSuffixes": [
      "comfy_local_run_workflow",
      "comfy_local_run_template",
      "comfy_local_generate_image",
      "comfy_local_vary_workflow"
    ],
    "uploadToolSuffix": "comfy_local_upload_file"
  },
  "staging": {
    "enabled": false,
    "hostInputRoot": null,
    "generatedOutputRoots": []
  }
}
```

### Important options

| Option | Meaning |
| --- | --- |
| `ollama.unloadPolicy` | `all` unloads everything reported by Ollama. `listed` unloads only exact names in `ollama.models`. |
| `gpu.minimumFreeMiB` | Absolute free-memory target. When `null`, `minimumFreeRatio` is used. |
| `timeouts.renderSeconds` | Maximum blocking render/recovery time. Set this above the longest expected generation. |
| `lock.path` | Shared lock for one physical GPU. Sessions coordinating the same GPU must use the same path. |
| `plugin.heavyToolSuffixes` | MCP tool suffixes that trigger a handoff. Hyphens in actual names are normalized to underscores. |
| `staging.enabled` | Tracks generated outputs uploaded back into ComfyUI input and removes only newly created copies at session idle. |

When staging cleanup is enabled, the plugin snapshots the input tree before upload and sets `overwrite: false`. It never deletes a target that existed before that upload. Leave this feature disabled unless the OpenCode process can see the same ComfyUI input directory as the container.

Supported environment overrides:

```text
OCVRAM_CONFIG
OCVRAM_DOTENV
OCVRAM_OLLAMA_URL
OCVRAM_OLLAMA_UNLOAD_POLICY
OCVRAM_OLLAMA_MODELS
OCVRAM_COMFY_URL
OCVRAM_MIN_FREE_MIB
OCVRAM_MIN_FREE_RATIO
OCVRAM_REQUEST_TIMEOUT_MS
OCVRAM_HANDOFF_TIMEOUT_SECONDS
OCVRAM_RENDER_TIMEOUT_SECONDS
OCVRAM_POLL_MS
OCVRAM_LOCK_PATH
OCVRAM_LOCK_TIMEOUT_SECONDS
OCVRAM_LOCK_STALE_SECONDS
OCVRAM_LOCK_HEARTBEAT_MS
OCVRAM_FORCE_BLOCKING
OCVRAM_HEAVY_TOOL_SUFFIXES
OCVRAM_UPLOAD_TOOL_SUFFIX
OCVRAM_STAGING_CLEANUP
OCVRAM_HOST_INPUT_ROOT
OCVRAM_GENERATED_OUTPUT_ROOTS
```

List values use commas or semicolons.

The `.env` parser does not execute shell code, expand variables, or run command substitutions. It reads only `NAME=value` assignments, optional quotes, comments, and an optional `export` prefix.

## Check before activation

All commands below are read-only unless `--execute` is present:

```bash
npm run verify
node bin/cli.js print-config --config examples/basic.json
node bin/cli.js doctor --config examples/basic.json
node bin/cli.js handoff-test --config examples/basic.json
```

The dry-run handoff test reports the loaded Ollama models, ComfyUI queue, GPU memory, and current lease. Once no generation or important model session is active, exercise the real lifecycle:

```bash
node bin/cli.js handoff-test --config examples/basic.json --execute
```

That command intentionally unloads the selected Ollama models and ComfyUI models, then releases the lease immediately. It does not stop either service.

For a reversible first-user migration from an older local gate, follow [docs/first-user-migration.md](docs/first-user-migration.md).

## Failure behavior

- Busy ComfyUI: fail closed without unloading Ollama or interrupting the queue.
- Ollama unload timeout: release the lease and do not submit the ComfyUI tool.
- Insufficient free VRAM: release the lease and do not submit the tool.
- Tool transport returns before its job: keep the hook open until the ComfyUI queue really drains.
- Render/tool failure: recover, free ComfyUI, and release the lease when the session reaches an end state.
- Missing after hook: recover on `session.idle`, `session.error`, or `session.deleted`.
- Crashed owner: a later caller can reclaim the lock when the PID is dead on the same host or its heartbeat exceeds `staleAfterSeconds`.

Unloading `all` models affects every Ollama client using that server. Use `listed` when the Ollama instance is shared with unrelated users.

## Development

The package intentionally has no runtime dependencies.

```bash
npm run check
npm test
npm run verify
npm pack --dry-run
```

Tests use local mock HTTP servers and temporary directories. They do not unload real models or mutate a real ComfyUI installation.

## References

- [OpenCode plugin documentation](https://opencode.ai/docs/plugins/)
- [Ollama generate API and `keep_alive`](https://docs.ollama.com/api/generate)
- [ComfyUI server implementation, including `/free`](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)

## License

Apache License 2.0. See [LICENSE](LICENSE).
