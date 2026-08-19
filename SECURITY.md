# Security policy

Please report security issues privately to the repository maintainer rather than opening a public issue.

This plugin is designed for trusted local Ollama and ComfyUI endpoints. It sends model names to Ollama and calls ComfyUI memory/queue APIs. It does not provide transport encryption, authentication, or authorization. Do not expose either service to an untrusted network solely to use this plugin.

The optional staging cleaner is constrained to resolved descendants of `staging.hostInputRoot` and only tracks files proven absent before an upload. Keep it disabled if the host/container path mapping is uncertain.
