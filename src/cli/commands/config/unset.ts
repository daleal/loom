import { Args } from '@oclif/core';
import { LoomCommand } from '../../index';

export default class Unset extends LoomCommand {
  static override description = 'Unset the project coding agent or model.';
  static override examples = [
    '<%= config.bin %> config unset agent',
    '<%= config.bin %> config unset model',
  ];
  static override args = {
    key: Args.string({ options: ['agent', 'model'], required: true, ignoreStdin: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Unset);
    await this.withLoom((loom) => loom.unsetConfig(args.key as 'agent' | 'model'));
  }
}
