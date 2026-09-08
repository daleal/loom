import { spawn } from 'node:child_process';

export type CommandOptions = {
  cwd: string;
  inherit?: boolean;
};

export type CommandRunner = {
  run(command: string, args: string[], options: CommandOptions): Promise<string>;
};

export class ProcessRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      let stdout = '';
      let stderr = '';
      let interrupted = false;
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const interrupt = () => {
        interrupted = true;
        child.kill('SIGTERM');
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      const cleanup = () => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      };
      child.once('error', (error) => {
        cleanup();
        reject(new Error(`Cannot start ${command}: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        cleanup();
        if (interrupted || code !== 0) {
          reject(
            new Error(
              `${command} ${interrupted ? 'interrupted' : `failed (${signal ?? code})`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            ),
          );
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}
