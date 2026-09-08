import { Args } from '@oclif/core';
import { agentFlag, LoomCommand } from '../index';

export default class Init extends LoomCommand {
  static override description =
    'Create loom.jsonc using one public GitHub repository. The branch defaults to main.';
  static override examples = ['<%= config.bin %> init daleal/threads:develop --agent opencode'];
  static override args = {
    source: Args.string({
      description: 'GitHub owner/repo[:branch]',
      required: true,
      ignoreStdin: true,
    }),
  };
  static override flags = {
    agent: agentFlag('Default coding agent. Available: opencode (requires opencode2).'),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);
    await this.withLoom((loom) => loom.init(args.source, flags.agent));
  }
}
