# Changelog

All notable changes to this project will be documented here. The format follows Keep a Changelog and the project intends to use semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-08-30

### Added

- Generic `beforeConsumer`, `afterConsumer`, and `recoverConsumer` lifecycle
  methods for local inference applications.
- A public lock export so integrations can inspect the shared lease protocol
  without reaching into package internals.

### Changed

- Verify that an external consumer has unloaded its own workers before free
  VRAM is checked and the shared lease is released.

### Fixed

- Serialize lease release with an in-flight heartbeat so a concurrent
  `owner.json` update cannot strand a live-looking lock after handback.

## [0.1.1] - 2026-08-19

### Fixed

- Recover GPU leases immediately from terminal OpenCode tool-error events instead
  of waiting for a later session event.
- Unload Ollama again during recovery when the model reloaded before the error
  event arrived.
- Recover a same-session orphan before its next heavy call, preventing a failed
  MCP request from deadlocking against its own lease.

### Changed

- Stop treating JSON-only `comfy_local_vary_workflow` calls as GPU-heavy by
  default. Installations where that tool renders can add it back through
  `plugin.heavyToolSuffixes` or `OCVRAM_HEAVY_TOOL_SUFFIXES`.

## [0.1.0] - 2026-08-19

### Added

- Exclusive heartbeat-backed GPU leases with stale-owner recovery.
- Verified Ollama unload and ComfyUI model/memory release.
- Blocking OpenCode MCP lifecycle hooks and orphan recovery.
- Optional safe cleanup for generated outputs staged as ComfyUI inputs.
- Read-only diagnostics, an explicit mutating handoff test, tests, and migration documentation.
- A non-overwriting local loader generator for reversible activation.
- Layered, dependency-free `.env` loading so machine-specific paths stay outside Git.
