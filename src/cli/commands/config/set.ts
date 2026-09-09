import { Args } from '@oclif/core';
import { LoomCommand } from '../../index';

export default class Set extends LoomCommand {
  static override description = 'Set the project coding agent or model.';
  static override examples = [
    '<%= config.bin %> config set agent opencode',
    '<%= config.bin %> config set model openai/gpt-5.4',
  ];
  static override args = {
    key: Args.string({ options: ['agent', 'model'], required: true, ignoreStdin: true }),
    value: Args.string({ description: 'Value to save', required: true, ignoreStdin: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Set);
    if (!args.value.trim()) throw new Error('Provide a nonempty value to set.');
    await this.withLoom((loom) => loom.setConfig(args.key as 'agent' | 'model', args.value));
  }
}
