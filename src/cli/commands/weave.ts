import { agentFlag, LoomCommand } from '../index';

export default class Weave extends LoomCommand {
  static override description =
    'Apply pending threads in order, each in a fresh autonomous agent session.';
  static override examples = [
    '<%= config.bin %> weave',
    '<%= config.bin %> weave --agent opencode',
  ];
  static override flags = {
    agent: agentFlag('Override the configured agent for this execution. Available: opencode.'),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Weave);
    await this.withLoom((loom) => loom.weave(flags.agent));
  }
}
