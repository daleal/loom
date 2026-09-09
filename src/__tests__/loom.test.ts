import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OpenCodeAdapter } from '../agents/opencode';
import { FileConfigStore } from '../config';
import type { AgentAdapter, ThreadRepository } from '../domain';
import { parseSource } from '../domain';
import { exists } from '../filesystem';
import { Loom } from '../loom';
import { ProcessRunner } from '../process';
import { GitHubThreadRepository } from '../repository';
import { ignoreCache, withWorkspaceLock } from '../workspace';

let directory: string;
const revision = 'a'.repeat(40);

beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true });
  directory = await mkdtemp(resolve('tmp/loom-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const setup = async (agent?: AgentAdapter) => {
  const config = new FileConfigStore(directory);
  const calls: string[] = [];
  const repository: ThreadRepository = {
    resolve: async () => {
      calls.push('resolve');
      return { revision, directory };
    },
    validate: async (_snapshot, names) => {
      calls.push(`validate:${names.join(',')}`);
    },
  };
  const loom = new Loom({
    config,
    repository,
    projectDirectory: directory,
    agents: new Map([
      [
        'opencode',
        agent ?? {
          isModelValid: async (model) => ['provider/default', 'provider/override'].includes(model),
          run: async (task) => {
            calls.push(`run:${task.name}`);
          },
        },
      ],
    ]),
  });
  await loom.init('daleal/threads', 'opencode');
  return { config, calls, repository, loom };
};

describe('configuration', () => {
  test('init defaults to main and refuses either existing config', async () => {
    const { config, loom } = await setup();
    expect((await config.read()).source).toBe('daleal/threads:main');
    expect(loom.init('other/repo')).rejects.toThrow('already exists');
    await rm(join(directory, 'loom.jsonc'));
    await writeFile(join(directory, 'loom.json'), '{}');
    expect(loom.init('other/repo')).rejects.toThrow('already exists');
  });

  test('prefers JSONC, preserves comments and edits only applied state', async () => {
    const path = join(directory, 'loom.jsonc');
    await writeFile(
      path,
      `{
\t// My source
\t"source": "daleal/threads:feature/setup",
\t"threads": [
\t\t// Keep this convention
\t\t{ "name": "bun", "applied": null },
\t],
\t"custom": true,
}\n`,
    );
    await writeFile(join(directory, 'loom.json'), 'invalid');
    const config = new FileConfigStore(directory);
    await config.append(['nuxt']);
    await config.markApplied('bun', revision);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('// My source');
    expect(text).toContain('// Keep this convention');
    expect(text).toContain('\t"custom": true');
    expect((await config.read()).threads).toEqual([
      { name: 'bun', applied: { revision } },
      { name: 'nuxt', applied: null },
    ]);
    expect(await readFile(join(directory, 'loom.json'), 'utf8')).toBe('invalid');
  });

  test('invalid JSONC does not fall back to JSON; JSON alone works', async () => {
    const config = new FileConfigStore(directory);
    await writeFile(
      join(directory, 'loom.json'),
      JSON.stringify({ source: 'daleal/threads:main', threads: [] }),
    );
    expect((await config.read()).threads).toEqual([]);
    await writeFile(join(directory, 'loom.jsonc'), '{ broken');
    expect(config.read()).rejects.toThrow('Invalid');
  });
});

describe('orchestration', () => {
  test('init validates before saving; config edits preserve comments and unset is idempotent', async () => {
    const { loom, config } = await setup();
    await rm(join(directory, 'loom.jsonc'));
    await expect(loom.init('daleal/threads', 'opencode', 'invalid')).rejects.toThrow(
      'Invalid model',
    );
    await expect(loom.init('daleal/threads', undefined, 'provider/default')).rejects.toThrow(
      'No agent',
    );
    expect(await exists(join(directory, 'loom.jsonc'))).toBe(false);
    await loom.init('daleal/threads', 'opencode', 'provider/default');
    expect((await config.read()).model).toBe('provider/default');
    const path = join(directory, 'loom.jsonc');
    await writeFile(path, (await readFile(path, 'utf8')).replace('{', '{\n  // Keep me'));
    const before = await readFile(path, 'utf8');
    await expect(loom.setConfig('model', 'invalid')).rejects.toThrow('Invalid model');
    await expect(loom.setConfig('agent', 'unknown')).rejects.toThrow('Unsupported agent');
    expect(await readFile(path, 'utf8')).toBe(before);
    await loom.setConfig('model', 'provider/override');
    expect((await config.read()).model).toBe('provider/override');
    await loom.unsetConfig('model');
    await loom.unsetConfig('model');
    await loom.unsetConfig('agent');
    expect((await config.read()).model).toBeUndefined();
    expect((await config.read()).agent).toBeUndefined();
    await expect(loom.setConfig('model', 'provider/default')).rejects.toThrow('No agent');
    await loom.setConfig('agent', 'opencode');
    expect(await readFile(path, 'utf8')).toContain('// Keep me');
  });

  test('weave validates the effective model before repository access and overrides transiently', async () => {
    const models: (string | undefined)[] = [];
    const { loom, config, calls } = await setup({
      isModelValid: async (model) => model === 'provider/override',
      run: async (task) => {
        models.push(task.model);
      },
    });
    await config.set('model', 'provider/stale');
    await config.append(['bun', 'nuxt']);
    await expect(loom.weave()).rejects.toThrow('Invalid model');
    expect(calls).toEqual([]);
    await loom.weave(undefined, 'provider/override');
    expect(models).toEqual(['provider/override', 'provider/override']);
    expect((await config.read()).model).toBe('provider/stale');
  });

  test('changing agent revalidates the saved model before persisting', async () => {
    const { config, repository } = await setup();
    await config.set('model', 'provider/default');
    const loom = new Loom({
      config,
      repository,
      projectDirectory: directory,
      agents: new Map([['other', { isModelValid: async () => false, run: async () => {} }]]),
    });
    await expect(loom.setConfig('agent', 'other')).rejects.toThrow('Invalid model');
    expect((await config.read()).agent).toBe('opencode');
  });

  test('add validates the full batch, preserves order, and does not duplicate', async () => {
    const { loom, calls, config } = await setup();
    await loom.add(['bun', 'nuxt', 'bun']);
    await loom.add(['bun', 'env']);
    expect(calls).toEqual(['resolve', 'validate:bun,nuxt,bun', 'resolve', 'validate:bun,env']);
    expect((await config.read()).threads.map((thread) => thread.name)).toEqual([
      'bun',
      'nuxt',
      'env',
    ]);
    expect((await config.read()).threads.every((thread) => thread.applied === null)).toBe(true);
  });

  test('missing thread leaves the entire add batch unchanged', async () => {
    const { loom, config, repository } = await setup();
    const before = await readFile(join(directory, 'loom.jsonc'), 'utf8');
    repository.validate = async () => {
      throw new Error('Missing: absent');
    };
    expect(loom.add(['bun', 'absent'])).rejects.toThrow('absent');
    expect(await config.read()).toEqual({
      source: 'daleal/threads:main',
      agent: 'opencode',
      threads: [],
    });
    expect(await readFile(join(directory, 'loom.jsonc'), 'utf8')).toBe(before);
  });

  test('validates every pending thread before any agent starts', async () => {
    const { loom, repository, calls } = await setup();
    await loom.add(['bun', 'nuxt']);
    calls.length = 0;
    repository.validate = async () => {
      throw new Error('Missing: nuxt');
    };
    expect(loom.weave()).rejects.toThrow('nuxt');
    expect(calls).toEqual(['resolve']);
  });

  test('stops on failure, keeps partial code, resumes pending threads at a newly resolved revision', async () => {
    const executions: string[] = [];
    let fail = true;
    const agent: AgentAdapter = {
      isModelValid: async () => true,
      run: async (task) => {
        executions.push(task.name);
        if (task.name === 'bun') await writeFile(join(task.projectDirectory, 'code.txt'), 'bun');
        if (task.name === 'nuxt') {
          expect(await readFile(join(task.projectDirectory, 'code.txt'), 'utf8')).toBe('bun');
          if (fail) throw new Error('Interrupted');
        }
      },
    };
    const { loom, config, repository } = await setup(agent);
    await loom.add(['bun', 'nuxt', 'env']);
    expect(loom.weave()).rejects.toThrow('Interrupted');
    expect(executions).toEqual(['bun', 'nuxt']);
    expect((await config.read()).threads.map((thread) => thread.applied)).toEqual([
      { revision },
      null,
      null,
    ]);
    fail = false;
    const nextRevision = 'b'.repeat(40);
    repository.resolve = async () => ({ revision: nextRevision, directory });
    await loom.weave();
    expect(executions).toEqual(['bun', 'nuxt', 'nuxt', 'env']);
    expect((await config.read()).threads.map((thread) => thread.applied?.revision)).toEqual([
      revision,
      nextRevision,
      nextRevision,
    ]);
    await loom.weave();
    expect(executions).toHaveLength(4);
  });

  test('agent override is transient; missing and unsupported agents fail before repository access', async () => {
    const { config, repository, calls } = await setup();
    await config.append(['bun']);
    const loom = new Loom({
      config,
      repository,
      projectDirectory: directory,
      agents: new Map([
        [
          'other',
          {
            isModelValid: async () => true,
            run: async () => {
              calls.push('other');
            },
          },
        ],
      ]),
    });
    expect(loom.weave()).rejects.toThrow('Unsupported agent');
    expect(calls).toEqual([]);
    await loom.weave('other');
    expect(calls).toEqual(['resolve', 'validate:bun', 'other']);
    expect((await config.read()).agent).toBe('opencode');
    await writeFile(
      join(directory, 'loom.jsonc'),
      JSON.stringify({ source: 'daleal/threads:main', threads: [] }),
    );
    expect(loom.weave()).rejects.toThrow('No agent configured');
  });
});

describe('adapters', () => {
  test('OpenCode validates exact model IDs in the project and passes the selected model', async () => {
    await writeFile(join(directory, 'INSTRUCTIONS.md'), 'Use Bun.');
    const calls: string[][] = [];
    const adapter = new OpenCodeAdapter(
      {
        run: async (command, args, options) => {
          expect(command).toBe('opencode2');
          expect(options.cwd).toBe(directory);
          calls.push(args);
          return 'provider/default\r\nprovider/override\r\n';
        },
      },
      directory,
    );
    expect(await adapter.isModelValid('provider/default')).toBe(true);
    expect(await adapter.isModelValid('provider/def')).toBe(false);
    expect(await adapter.isModelValid('')).toBe(false);
    expect(calls.every((args) => args.join() === 'models')).toBe(true);
    await adapter.run({
      projectDirectory: directory,
      threadDirectory: directory,
      name: 'bun',
      model: 'provider/override',
    });
    expect(calls.at(-1)).toContain('--model');
    expect(calls.at(-1)).toContain('provider/override');
  });

  test('GitHub resolves the exact branch once and checks out its commit', async () => {
    const calls: string[][] = [];
    const repository = new GitHubThreadRepository(join(directory, 'cache'), {
      run: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return args[0] === 'rev-parse' ? revision : '';
      },
    });
    const snapshot = await repository.resolve('daleal/threads:feature/setup');
    expect(snapshot.revision).toBe(revision);
    expect(calls).toContainEqual([
      'fetch',
      '--depth=1',
      '--no-tags',
      'https://github.com/daleal/threads.git',
      'refs/heads/feature/setup',
    ]);
    expect(calls).toContainEqual(['checkout', '--detach', '--force', revision]);
  });

  test('validates all missing instructions, rejects directory symlinks, accepts arbitrary reference files', async () => {
    const repository = new GitHubThreadRepository(directory, new ProcessRunner());
    await mkdir(join(directory, 'bun', 'references'), { recursive: true });
    await writeFile(join(directory, 'bun', 'INSTRUCTIONS.md'), 'Anything goes.');
    await writeFile(join(directory, 'bun', 'references', 'example.ts'), 'export const value = 1;');
    await symlink(join(directory, 'bun'), join(directory, 'alias'));
    await repository.validate({ directory, revision }, ['bun']);
    expect(
      repository.validate({ directory, revision }, ['absent', 'alias', 'nuxt']),
    ).rejects.toThrow('absent, alias, nuxt');
  });

  test('OpenCode gets only the current thread, fresh autonomous sessions, and no model override', async () => {
    await writeFile(join(directory, 'INSTRUCTIONS.md'), 'Use Bun.');
    const calls: string[][] = [];
    const adapter = new OpenCodeAdapter(
      {
        run: async (command, args, options) => {
          expect(command).toBe('opencode2');
          expect(options.cwd).toBe(directory);
          expect(options.inherit).toBe(true);
          calls.push(args);
          return '';
        },
      },
      directory,
    );
    await adapter.run({ projectDirectory: directory, threadDirectory: directory, name: 'bun' });
    await adapter.run({ projectDirectory: directory, threadDirectory: directory, name: 'bun' });
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['run', '--auto']);
      expect(args).not.toContain('--session');
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--model');
      expect(args.at(-1)).toContain('Use Bun.');
      expect(args.at(-1)).toContain(directory);
    }
  });

  test('process failures propagate and successful commands use the project cwd', async () => {
    const runner = new ProcessRunner();
    expect(
      await runner.run(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: directory }),
    ).toBe(directory);
    expect(
      runner.run(process.execPath, ['-e', 'console.error("failed task"); process.exit(3)'], {
        cwd: directory,
      }),
    ).rejects.toThrow('failed task');
    expect(runner.run('loom-nonexistent-executable', [], { cwd: directory })).rejects.toThrow(
      'Cannot start',
    );
  });
});

test('workspace lock excludes concurrent commands and releases after failure', async () => {
  expect(
    withWorkspaceLock(directory, async () => {
      expect(withWorkspaceLock(directory, async () => {})).rejects.toThrow('Another Loom command');
      throw new Error('failure');
    }),
  ).rejects.toThrow('failure');
  await withWorkspaceLock(directory, async () => {});
  await writeFile(join(directory, '.gitignore'), 'node_modules');
  await ignoreCache(directory);
  await ignoreCache(directory);
  expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('node_modules\n/.loom/\n');
});

test('source branches support slash-separated names and reject malformed refs', () => {
  expect(parseSource('daleal/threads:feature/setup').branch).toBe('feature/setup');
  for (const source of [
    'daleal/..',
    'daleal/threads:',
    'daleal/threads:../main',
    'daleal/threads:bad ref',
  ]) {
    expect(() => parseSource(source)).toThrow();
  }
});

test('CLI end-to-end: init, add, autonomous subprocesses, persisted state, and no-op reweave', async () => {
  const binaryDirectory = join(directory, 'bin');
  await mkdir(binaryDirectory);
  await writeFile(
    join(binaryDirectory, 'git'),
    `#!${process.execPath}
import { mkdir, writeFile } from 'node:fs/promises';
const command = process.argv[2];
if (command === 'init') await mkdir('.git', { recursive: true });
if (command === 'rev-parse') console.log('${revision}');
if (command === 'checkout') {
  for (const name of ['bun', 'nuxt']) {
    await mkdir(name, { recursive: true });
    await writeFile(name + '/INSTRUCTIONS.md', 'Implement ' + name);
  }
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binaryDirectory, 'opencode2'),
    `#!${process.execPath}
import { appendFile, readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('provider/default\\nprovider/override'); process.exit(0); }
if (args[0] !== 'run' || !args.includes('--auto') || args.includes('--session')) process.exit(2);
if (args[args.indexOf('--model') + 1] !== 'provider/override') process.exit(5);
const prompt = args.at(-1);
if (prompt.includes('Implement nuxt')) {
  if ((await readFile('applied.txt', 'utf8')) !== 'bun\\n') process.exit(3);
  await appendFile('applied.txt', 'nuxt\\n');
} else if (prompt.includes('Implement bun')) {
  await appendFile('applied.txt', 'bun\\n');
} else process.exit(4);
`,
    { mode: 0o755 },
  );
  const entrypoint = resolve('src/index.ts');
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, entrypoint, ...args], {
      cwd: directory,
      env: { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const help = await run('--help');
  expect(help.code).toBe(0);
  for (const name of ['init', 'add', 'weave']) expect(help.stdout).toContain(name);
  expect((await run()).code).toBe(0);
  for (const name of ['init', 'add', 'weave']) {
    const commandHelp = await run(name, '-h');
    expect(commandHelp.code).toBe(0);
    expect(commandHelp.stdout).toContain(`loom ${name}`);
  }
  for (const args of [
    ['remove', 'bun'],
    ['init'],
    ['init', 'daleal/threads', 'extra'],
    ['init', 'daleal/threads', '--agent', ''],
    ['add'],
    ['add', 'bun', '--agent', 'opencode'],
    ['weave', 'extra'],
    ['weave', '--unknown'],
    ['weave', '--agent'],
  ]) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
  }
  expect(await exists(join(directory, '.loom'))).toBe(false);
  expect(await exists(join(directory, 'loom.jsonc'))).toBe(false);
  expect(
    (await run('init', 'daleal/threads:dev', '--agent', 'opencode', '--model', 'provider/default'))
      .code,
  ).toBe(0);
  expect((await run('config', 'set', 'model', 'invalid')).code).toBe(1);
  expect((await run('config', 'unset', 'source')).code).not.toBe(0);
  expect((await run('config', 'set', 'model')).code).not.toBe(0);
  expect((await run('config', 'unset', 'model', 'extra')).code).not.toBe(0);
  expect((await run('config', 'unset', 'model')).code).toBe(0);
  expect((await run('config', 'unset', 'agent')).code).toBe(0);
  expect((await run('config', 'set', 'agent', 'opencode')).code).toBe(0);
  expect((await run('config', 'set', 'model', 'provider/default')).code).toBe(0);
  expect((await run('init', 'other/repo')).code).toBe(1);
  expect((await run('add', 'bun', 'nuxt')).code).toBe(0);
  const result = await run('weave', '--model', 'provider/override');
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(await readFile(join(directory, 'applied.txt'), 'utf8')).toBe('bun\nnuxt\n');
  const config = await new FileConfigStore(directory).read();
  expect(config.source).toBe('daleal/threads:dev');
  expect(config.model).toBe('provider/default');
  expect(config.threads.map((thread) => thread.applied)).toEqual([{ revision }, { revision }]);
  expect((await run('weave')).stdout).toContain('No pending threads');
  expect(await readFile(join(directory, 'applied.txt'), 'utf8')).toBe('bun\nnuxt\n');
});
