import { Args } from '@oclif/core';
import { LoomCommand } from '../index';

export default class Add extends LoomCommand {
  static override description = 'Validate threads and append new names in argument order.';
  static override examples = ['<%= config.bin %> add bun nuxt env-variables'];
  static override args = {
    threads: Args.string({
      description: 'Root-level thread directory names',
      required: true,
      multiple: true,
      ignoreStdin: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Add);
    await this.withLoom((loom) => loom.add(args.threads));
  }
}
