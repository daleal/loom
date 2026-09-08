import { join } from 'node:path';
import { Command, Flags } from '@oclif/core';
import { OpenCodeAdapter } from '../agents/opencode';
import { FileConfigStore } from '../config';
import { Loom } from '../loom';
import { ProcessRunner } from '../process';
import { GitHubThreadRepository } from '../repository';
import { ignoreCache, withWorkspaceLock } from '../workspace';

export const agentFlag = (description: string) =>
  Flags.string({
    description,
    helpValue: 'name',
    parse: async (value) => {
      if (!value.trim()) throw new Error('--agent cannot be empty.');
      return value;
    },
  });

export abstract class LoomCommand extends Command {
  static override baseFlags = { help: Flags.help({ char: 'h' }) };

  protected async withLoom(action: (loom: Loom) => Promise<void>): Promise<void> {
    const directory = process.cwd();
    const commands = new ProcessRunner();
    const loom = new Loom({
      config: new FileConfigStore(directory),
      repository: new GitHubThreadRepository(join(directory, '.loom', 'sources'), commands),
      agents: new Map([['opencode', new OpenCodeAdapter(commands)]]),
      projectDirectory: directory,
      log: (message) => this.log(message),
    });
    await withWorkspaceLock(directory, async () => {
      await action(loom);
      await ignoreCache(directory);
    });
  }
}
