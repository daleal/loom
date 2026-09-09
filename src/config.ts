import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { regex } from 'arkregex';
import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import type { ConfigStore, LoomConfig } from './domain';
import { parseSource, validateThreadName } from './domain';
import { exists } from './filesystem';

const revisionPattern = regex('^[a-f0-9]{40,64}$');
const indentationPattern = regex('(?:\r?\n)(?<indentation>[\t ]+)\\S');

const validate: (value: unknown) => asserts value is LoomConfig = (value) => {
  if (!value || typeof value !== 'object') throw new Error('Expected a configuration object.');
  const config = value as LoomConfig;
  if (typeof config.source !== 'string') throw new Error('Configuration requires a source.');
  parseSource(config.source);
  if (config.agent !== undefined && (typeof config.agent !== 'string' || !config.agent.trim())) {
    throw new Error('agent must be a nonempty string.');
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || !config.model.trim())) {
    throw new Error('model must be a nonempty string.');
  }
  if (!Array.isArray(config.threads)) throw new Error('threads must be an ordered array.');
  const names = new Set<string>();
  for (const thread of config.threads) {
    if (!thread || typeof thread.name !== 'string') throw new Error('Each thread requires a name.');
    validateThreadName(thread.name);
    if (names.has(thread.name)) throw new Error(`Duplicate thread: ${thread.name}`);
    names.add(thread.name);
    if (
      thread.applied !== null &&
      (!thread.applied ||
        typeof thread.applied.revision !== 'string' ||
        !revisionPattern.test(thread.applied.revision))
    ) {
      throw new Error(`Invalid applied revision for thread: ${thread.name}`);
    }
  }
};

export class FileConfigStore implements ConfigStore {
  constructor(private readonly directory: string) {}

  async create(config: LoomConfig): Promise<void> {
    for (const name of ['loom.jsonc', 'loom.json']) {
      if (await exists(join(this.directory, name))) throw new Error(`${name} already exists.`);
    }
    validate(config);
    await writeFile(join(this.directory, 'loom.jsonc'), `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
    });
  }

  private async document() {
    const jsonc = join(this.directory, 'loom.jsonc');
    const path = (await exists(jsonc)) ? jsonc : join(this.directory, 'loom.json');
    if (!(await exists(path))) throw new Error('No Loom configuration found. Run loom init first.');
    const text = await readFile(path, 'utf8');
    const errors: ParseError[] = [];
    const config: unknown = parse(text, errors, {
      allowTrailingComma: path.endsWith('.jsonc'),
      disallowComments: !path.endsWith('.jsonc'),
    });
    if (errors.length) {
      throw new Error(
        `Invalid ${path}: ${errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(', ')}`,
      );
    }
    validate(config);
    return { path, text, config };
  }

  async read(): Promise<LoomConfig> {
    return (await this.document()).config;
  }

  private async edit(updates: { path: (string | number)[]; value: unknown }[]): Promise<void> {
    if (!updates.length) return;
    const document = await this.document();
    const indentation = indentationPattern.exec(document.text)?.groups.indentation ?? '  ';
    let text = document.text;
    for (const { path, value } of updates) {
      text = applyEdits(
        text,
        modify(text, path, value, {
          formattingOptions: {
            insertSpaces: !indentation.includes('\t'),
            tabSize: indentation.length,
            eol: document.text.includes('\r\n') ? '\r\n' : '\n',
          },
        }),
      );
    }
    const pending = `${document.path}.pending`;
    try {
      await writeFile(pending, text);
      await rename(pending, document.path);
    } finally {
      await unlink(pending).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async append(names: string[]): Promise<void> {
    const config = await this.read();
    const additions = [...new Set(names)].filter(
      (name) => !config.threads.some((thread) => thread.name === name),
    );
    // Target each insertion to preserve comments, then persist the batch atomically.
    await this.edit(
      additions.map((name) => ({ path: ['threads', -1], value: { name, applied: null } })),
    );
  }

  async markApplied(name: string, revision: string): Promise<void> {
    const config = await this.read();
    const index = config.threads.findIndex((thread) => thread.name === name);
    if (index < 0) throw new Error(`Thread ${name} disappeared from the configuration.`);
    await this.edit([{ path: ['threads', index, 'applied'], value: { revision } }]);
  }
}
