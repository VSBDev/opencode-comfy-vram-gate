# Changelog

All notable changes to this project will be documented here. The format follows Keep a Changelog and the project intends to use semantic versioning.

## [Unreleased]

## [0.1.0] - 2026-08-19

### Added

- Exclusive heartbeat-backed GPU leases with stale-owner recovery.
- Verified Ollama unload and ComfyUI model/memory release.
- Blocking OpenCode MCP lifecycle hooks and orphan recovery.
- Optional safe cleanup for generated outputs staged as ComfyUI inputs.
- Read-only diagnostics, an explicit mutating handoff test, tests, and migration documentation.
- A non-overwriting local loader generator for reversible activation.
- Layered, dependency-free `.env` loading so machine-specific paths stay outside Git.
