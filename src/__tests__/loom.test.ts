import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileConfigStore } from '../config';
import type { AgentAdapter, ThreadRepository } from '../domain';
import { parseSource } from '../domain';
import { Loom } from '../loom';

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
