# Reversible first-user migration

This procedure keeps an installed prototype intact until the candidate passes isolated checks. Never load both plugins at once: OpenCode executes both hook sets.

Define the locations for the current shell instead of writing machine-specific paths into the repository:

```bash
export VRAM_GATE_REPOSITORY="$(pwd)"
export OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
export ACTIVE_GATE_PLUGIN="$OPENCODE_CONFIG_DIR/plugins/comfy-vram-gate.js"
export PROTOTYPE_GATE_BACKUP="$OPENCODE_CONFIG_DIR/comfy-vram-gate.prototype.js"
```

## 1. Leave the current plugin active

Create the private configuration and edit it for the machine. `.env` is ignored by Git:

```bash
cd "$VRAM_GATE_REPOSITORY"
cp .env.example .env
${EDITOR:-vi} .env
```

Keep all host paths, container paths, model selections, URLs, and memory thresholds in that private file. Validate the candidate without changing the installed plugin:

```bash
npm run verify
node bin/cli.js print-config
node bin/cli.js doctor
node bin/cli.js handoff-test
```

The commands above are read-only. When Ollama and ComfyUI are idle and it is acceptable to unload their models, run the isolated lifecycle test:

```bash
node bin/cli.js handoff-test --execute
```

This calls the new core directly. The installed OpenCode plugin remains unchanged.

## 2. Switch only while OpenCode is stopped

Close all OpenCode processes first. Preserve the current plugin outside the auto-loaded plugin directory, then generate the candidate loader:

```bash
mv "$ACTIVE_GATE_PLUGIN" "$PROTOTYPE_GATE_BACKUP"
node "$VRAM_GATE_REPOSITORY/bin/create-loader.js" "$ACTIVE_GATE_PLUGIN"
```

The loader generator refuses to overwrite a file. Start one fresh OpenCode session and exercise at least one short image render and one long video render. Confirm:

- the heavy MCP call has `wait: true`;
- Ollama is absent from `GET /api/ps` before the render starts;
- ComfyUI completes without an out-of-memory error;
- the returned asset exists at the path reported by the MCP tool;
- `node bin/cli.js status` shows no stale lease after completion;
- a subsequent OpenCode response makes Ollama reload normally.

## 3. Roll back if anything is wrong

Stop OpenCode, remove only the generated candidate loader, and restore the preserved prototype:

```bash
rm "$ACTIVE_GATE_PLUGIN"
mv "$PROTOTYPE_GATE_BACKUP" "$ACTIVE_GATE_PLUGIN"
```

The candidate repository and its private `.env` can remain for diagnosis; neither replaces the restored plugin.

## 4. Finish the migration

Keep the prototype backup until the new gate has survived normal multi-session use. Remove it only when the rollback window is intentionally closed.
