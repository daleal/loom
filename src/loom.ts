import { join } from 'node:path';
import type { AgentAdapter, ConfigStore, ThreadRepository } from './domain';
import { parseSource, validateThreadName } from './domain';

export type LoomDependencies = {
  config: ConfigStore;
  repository: ThreadRepository;
  agents: ReadonlyMap<string, AgentAdapter>;
  projectDirectory: string;
  log?: (message: string) => void;
};

export class Loom {
  constructor(private readonly dependencies: LoomDependencies) {}

  async init(source: string, agent?: string): Promise<void> {
    const parsed = parseSource(source);
    await this.dependencies.config.create({
      source: `${parsed.repository}:${parsed.branch}`,
      ...(agent ? { agent } : {}),
      threads: [],
    });
    this.dependencies.log?.('Created loom.jsonc.');
  }

  async add(names: string[]): Promise<void> {
    if (!names.length) throw new Error('Provide at least one thread name.');
    names.forEach(validateThreadName);
    const { config, repository } = this.dependencies;
    const current = await config.read();
    const snapshot = await repository.resolve(current.source);
    await repository.validate(snapshot, names);
    const additions = [...new Set(names)].filter(
      (name) => !current.threads.some((thread) => thread.name === name),
    );
    await config.append(additions);
    this.dependencies.log?.(
      additions.length
        ? `Added: ${additions.join(', ')}.`
        : 'All requested threads are already selected.',
    );
  }

  async weave(overrideAgent?: string): Promise<void> {
    const { config, repository, agents, projectDirectory, log } = this.dependencies;
    const current = await config.read();
    const agentName = overrideAgent ?? current.agent;
    if (!agentName)
      throw new Error('No agent configured. Pass --agent or set agent in loom.jsonc.');
    const agent = agents.get(agentName);
    if (!agent)
      throw new Error(
        `Unsupported agent: ${agentName}. Available: ${[...agents.keys()].join(', ')}.`,
      );
    const pending = current.threads.filter((thread) => thread.applied === null);
    if (!pending.length) {
      log?.('No pending threads.');
      return;
    }
    const snapshot = await repository.resolve(current.source);
    await repository.validate(
      snapshot,
      pending.map((thread) => thread.name),
    );
    for (const thread of pending) {
      log?.(`Weaving ${thread.name} (${snapshot.revision}) with ${agentName}...`);
      await agent.run({
        projectDirectory,
        threadDirectory: join(snapshot.directory, thread.name),
        name: thread.name,
      });
      await config.markApplied(thread.name, snapshot.revision);
      log?.(`Applied ${thread.name}.`);
    }
  }
}
