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
loom init daleal/lthreads --agent opencode
loom add bun nuxt env-variables
loom weave
```

`init` creates `loom.jsonc`. The source is one public GitHub repository. Its branch defaults to `main`, regardless of the repository's default branch. Use `daleal/lthreads:develop` or `daleal/lthreads:feature/setup` to select another branch. Initialization fails if either `loom.jsonc` or `loom.json` already exists.

`add` checks every requested thread against the configured branch before changing the configuration. New names go at the end in argument order. Existing names keep their position and applied state. Adding a thread does not pin its version.

`weave` uses `--agent` when supplied, otherwise the configured agent. The override does not change the configuration. Missing or unsupported agents produce an error. Only `opencode` is currently supported.

```sh
loom init daleal/lthreads:develop
loom add bun
loom weave --agent opencode
```

At the start of a weave with pending threads, Loom resolves the branch to one commit and checks that every pending thread exists. It then executes them sequentially. Each successful agent process records that commit in the thread's `applied` field. Loom does not verify the implementation itself.

If an agent fails or is interrupted, weaving stops. Completed threads stay applied; the failed thread stays pending and any partial code changes remain. Running `weave` again resolves the branch again and applies only pending threads.

## Configuration

Select a model at initialization or override it for one weave:

```sh
loom init daleal/lthreads --agent opencode --model openai/gpt-5.6-sol
loom weave --model openai/gpt-5.6-luna
```

`init --model` saves the model and requires `--agent`. `weave --model` overrides the saved model for that execution. Without either, the agent uses its own default. Loom validates model IDs before saving and before weaving. For OpenCode, use an exact ID from `opencode2 models` in the project directory.

```sh
loom config set agent opencode
loom config set model openai/gpt-5.6-sol
loom config unset model
loom config unset agent
```

`config` edits the existing project configuration. Supported keys are `agent` and `model`. Setting a model requires a configured agent; changing agents revalidates any saved model. Unsetting a key removes only that key and succeeds if it is already absent. After unsetting the agent, configure one or pass `weave --agent` before weaving.

Commands prefer `loom.jsonc` over `loom.json`. An invalid JSONC file produces an error rather than falling back to JSON. Updates preserve comments and use targeted edits.

```jsonc
{
  "source": "daleal/lthreads:main",
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
- `src/agents/opencode.ts` validates models with `opencode2 models` and runs `opencode2 run --auto`, passing the selected model when supplied. OpenCode's explicitly denied permissions still apply.
- `src/process.ts` owns subprocess execution and interruption handling.
- `src/cli/commands/` contains the oclif command classes and their argument, flag, and help definitions.
- `src/cli/index.ts` provides the shared command base with workspace locking and application setup; `src/index.ts` starts oclif.
- `src/workspace.ts` handles the command lock and cache ignore entry.

To support another agent, implement `AgentAdapter` and register it in `src/cli/index.ts`. `isModelValid(model)` checks a model ID against available models. `run` must honor the task's optional model, start a fresh autonomous session, resolve on success, and reject on failure or interruption.

## Development

```sh
bun test
bun run typecheck
bun run lint
bun run format:check
bun run build
```

Tests use isolated directories under `tmp/` and fake agent adapters. They do not invoke a model or require GitHub access. The build compiles the entrypoint and command modules into `dist/`. Run `bun dist/index.js --help` from this installation to use the compiled CLI. Both entrypoints discover their adjacent `cli/commands/` directory.
