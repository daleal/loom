import { join } from 'node:path';
import type { AgentAdapter, ConfigKey, ConfigStore, ThreadRepository } from './domain';
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

  private agent(name?: string): AgentAdapter {
    const { agents } = this.dependencies;
    if (!name)
      throw new Error('No agent configured. Pass --agent or run loom config set agent <name>.');
    const adapter = agents.get(name);
    if (!adapter)
      throw new Error(`Unsupported agent: ${name}. Available: ${[...agents.keys()].join(', ')}.`);
    return adapter;
  }

  private async validateModel(agent: AgentAdapter, model?: string): Promise<void> {
    if (model === undefined) return;
    if (!model.trim()) throw new Error('model must be a nonempty string.');
    if (!(await agent.isModelValid(model))) {
      throw new Error(`Invalid model for the selected agent: ${model}.`);
    }
  }

  async init(source: string, agent?: string, model?: string): Promise<void> {
    const parsed = parseSource(source);
    if (agent !== undefined || model !== undefined)
      await this.validateModel(this.agent(agent), model);
    await this.dependencies.config.create({
      source: `${parsed.repository}:${parsed.branch}`,
      ...(agent ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      threads: [],
    });
    this.dependencies.log?.('Created loom.jsonc.');
  }

  async setConfig(key: ConfigKey, value: string): Promise<void> {
    if (!value.trim()) throw new Error(`${key} must be a nonempty string.`);
    const current = await this.dependencies.config.read();
    const agent = this.agent(key === 'agent' ? value : current.agent);
    await this.validateModel(agent, key === 'model' ? value : current.model);
    await this.dependencies.config.set(key, value);
    this.dependencies.log?.(`Set ${key} to ${value}.`);
  }

  async unsetConfig(key: ConfigKey): Promise<void> {
    await this.dependencies.config.set(key, undefined);
    this.dependencies.log?.(`Unset ${key}.`);
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

  async weave(overrideAgent?: string, overrideModel?: string): Promise<void> {
    const { config, repository, projectDirectory, log } = this.dependencies;
    const current = await config.read();
    const agentName = overrideAgent ?? current.agent;
    const agent = this.agent(agentName);
    const model = overrideModel ?? current.model;
    await this.validateModel(agent, model);
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
        ...(model !== undefined ? { model } : {}),
      });
      await config.markApplied(thread.name, snapshot.revision);
      log?.(`Applied ${thread.name}.`);
    }
  }
}
