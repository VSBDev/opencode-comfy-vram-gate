# Contributing

Issues and pull requests are welcome. Please describe the GPU topology, OpenCode version, Ollama version, ComfyUI version, relevant configuration with secrets removed, and the exact tool lifecycle that failed.

Before submitting a change:

```bash
npm run verify
npm pack --dry-run
```

Tests must not require a real GPU or mutate live Ollama/ComfyUI services. Add mock-server coverage for lifecycle changes, and preserve the fail-closed rules: never interrupt a busy ComfyUI queue, never submit without verified free memory, and never release another process's lease.
