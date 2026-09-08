# Loom

Compose a starting codebase from reusable instructions called threads. Loom applies them in order, each in a fresh coding-agent session. The codebase left by the previous thread is the next session's context.

## Setup

Requires Bun, Git, and OpenCode V2's `opencode2` executable on `PATH`. Configure your model and credentials in OpenCode before weaving.

```sh
bun install
bun link
```

## Usage

Run Loom from the root of your project:

```sh
loom init daleal/threads --agent opencode
loom add bun nuxt env-variables
loom weave
```

`init` creates `loom.jsonc`. The source is one public GitHub repository. Its branch defaults to `main`, regardless of the repository's default branch. Use `daleal/threads:develop` or `daleal/threads:feature/setup` to select another branch. Initialization fails if either `loom.jsonc` or `loom.json` already exists.

`add` checks every requested thread against the configured branch before changing the configuration. New names go at the end in argument order. Existing names keep their position and applied state. Adding a thread does not pin its version.

`weave` uses `--agent` when supplied, otherwise the configured agent. The override does not change the configuration. Missing or unsupported agents produce an error. Only `opencode` is currently supported.

```sh
loom init daleal/threads:develop
loom add bun
loom weave --agent opencode
```

At the start of a weave with pending threads, Loom resolves the branch to one commit and checks that every pending thread exists. It then executes them sequentially. Each successful agent process records that commit in the thread's `applied` field. Loom does not verify the implementation itself.

If an agent fails or is interrupted, weaving stops. Completed threads stay applied; the failed thread stays pending and any partial code changes remain. Running `weave` again resolves the branch again and applies only pending threads.

## Configuration

Commands prefer `loom.jsonc` over `loom.json`. An invalid JSONC file produces an error rather than falling back to JSON. Updates preserve comments and use targeted edits.

```jsonc
{
  "source": "daleal/threads:main",
  "agent": "opencode",
  "threads": [
    // Execution follows this order.
    { "name": "bun", "applied": null },
    { "name": "nuxt", "applied": null },
  ],
}
```

After application, an entry contains `"applied": { "revision": "<full commit hash>" }`. Commit the configuration along with your project. Edit it directly to reorder or delete entries, change the source or agent, or set `applied` back to `null` to reapply a thread. Deleting an entry does not undo code changes.

Downloaded files live in `.loom/sources/`. Loom adds `/.loom/` to `.gitignore`. The cache is disposable when no Loom command is running. A lock prevents concurrent Loom commands in the same project. Normal failures release it; after a forced termination, remove `.loom/lock` once you have confirmed the old command is no longer running.

## Writing threads

Each thread is a root-level directory containing `INSTRUCTIONS.md`:

```text
bun/
  INSTRUCTIONS.md
nuxt/
  INSTRUCTIONS.md
  references/
    with-backend.md
    just-frontend.md
env-variables/
  INSTRUCTIONS.md
  references/
    example.ts
```

Thread names use letters, digits, dots, underscores, and hyphens, starting with a letter or digit. All additional files and subdirectories are available to the agent. Instructions have no required sections or metadata.

For useful autonomous threads, include the decisions you already know, explain when reference files apply, and account for existing code. If you have a meaningful verification command, include it. These are writing suggestions, not validation rules. Loom tells the agent to make decisions rather than ask questions when information is missing.

## Architecture

- `src/domain.ts` defines `ConfigStore`, `ThreadRepository`, and `AgentAdapter`.
- `src/loom.ts` coordinates selection, validation, ordered execution, and completion state through those interfaces.
- `src/config.ts` handles JSON/JSONC discovery and edits.
- `src/repository.ts` resolves GitHub branches and checks out thread files through Git.
- `src/agents/opencode.ts` runs `opencode2 run --auto` without session continuation or model overrides. OpenCode's explicitly denied permissions still apply.
- `src/process.ts` owns subprocess execution and interruption handling.
- `src/cli/commands/` contains the oclif command classes and their argument, flag, and help definitions.
- `src/cli/index.ts` provides the shared command base with workspace locking and application setup; `src/index.ts` starts oclif.
- `src/workspace.ts` handles the command lock and cache ignore entry.

To support another agent, implement `AgentAdapter` and register it in `src/cli/index.ts`. `run` must start a fresh autonomous session, resolve on success, and reject on failure or interruption.

## Development

```sh
bun test
bun run typecheck
bun run lint
bun run format:check
bun run build
```

Tests use isolated directories under `tmp/` and fake agent adapters. They do not invoke a model or require GitHub access. The build compiles the entrypoint and command modules into `dist/`. Run `bun dist/index.js --help` from this installation to use the compiled CLI. Both entrypoints discover their adjacent `cli/commands/` directory.
