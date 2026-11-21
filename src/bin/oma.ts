#!/usr/bin/env bun
import { AppController, connectTernSession } from '../app/controller';
import {
  CliParseError,
  createAcpPlainAdapter,
  formatHelpText,
  formatVersionText,
  parseCliArgs,
  plainSameDir,
  runFallbackAgy,
  runPlainRepl,
} from '../app/fallback';
import { cleanupStaleWindowsBackup, runUpdateCommand } from '../app/updater';
import { loadConfig } from '../config/config';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  cleanupStaleWindowsBackup();

  if (argv[0] === 'update') {
    return runUpdateCommand(argv.slice(1));
  }

  let cli;
  try {
    cli = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliParseError) {
      process.stderr.write(`oma: ${err.message}\n\n${formatHelpText()}\n`);
      return 2;
    }
    throw err;
  }

  if (cli.version) {
    process.stdout.write(`${formatVersionText()}\n`);
    return 0;
  }

  if (cli.help) {
    process.stdout.write(`${formatHelpText()}\n`);
    return 0;
  }

  const { config, warnings } = await loadConfig();
  const cwd = process.cwd();

  if (cli.plain) {
    for (const w of warnings) {
      process.stderr.write(`[oma] config warning: ${w}\n`);
    }
    const agyBin = cli.agyBin?.trim() || config.agy_bin?.trim() || 'agy';
    const adapter = createAcpPlainAdapter({
      agyBin,
      addDirs: cli.addDirs,
      cwd,
    });
    return runPlainRepl({
      cli,
      cwd,
      adapter,
      sameDir: plainSameDir,
    });
  }

  const connected = await connectTernSession();
  if (!connected) {
    if (cli.noFallback) {
      process.stderr.write(
        'oma: Tern Surface Protocol (TSP) is not available in this terminal (non-TTY, TERN_TSP=0, or unsupported terminal) and --no-fallback was specified.\n' +
          'Run inside Tern, remove --no-fallback to launch native agy, or pass --plain for line-based REPL mode.\n'
      );
      return 1;
    }

    return runFallbackAgy({
      cli,
      configAgyBin: config.agy_bin,
      cwd,
    });
  }

  const controller = new AppController({
    cli,
    config,
    cwd,
    session: connected.session,
    output: connected.output,
  });

  if (warnings.length > 0) {
    controller.store.pushToast(warnings[0]!, 'warning');
  }

  return controller.run();
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
