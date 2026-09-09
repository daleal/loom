import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, AgentTask } from '../domain';
import type { CommandRunner } from '../process';

export class OpenCodeAdapter implements AgentAdapter {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectDirectory: string,
  ) {}

  async isModelValid(model: string): Promise<boolean> {
    if (!model.trim()) return false;
    const output = await this.commands.run('opencode2', ['models'], { cwd: this.projectDirectory });
    return output.split('\n').some((line) => line.trim() === model);
  }

  async run(task: AgentTask): Promise<void> {
    const instructions = await readFile(join(task.threadDirectory, 'INSTRUCTIONS.md'), 'utf8');
    const prompt = [
      `Implement the following thread in the current project: ${task.name}.`,
      'Work autonomously. Do not ask questions; make reasonable decisions when information is missing.',
      `Thread files are available at ${JSON.stringify(task.threadDirectory)}. Resolve reference paths relative to that directory.`,
      'Treat the thread directory as read-only. Do not modify loom.jsonc, loom.json, or Loom cache/state.',
      '',
      instructions,
    ].join('\n');
    await this.commands.run(
      'opencode2',
      [
        'run',
        '--auto',
        '--title',
        `[loom] ${task.name}`,
        ...(task.model ? ['--model', task.model] : []),
        prompt,
      ],
      {
        cwd: task.projectDirectory,
        inherit: true,
      },
    );
  }
}
