import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { migrateRoutingConfig, type MigrationOptions } from './migrate-routing-config-core.js';

function parseArgs(args: readonly string[]): MigrationOptions {
  const write = args.includes('--write');
  const updateEnv = !args.includes('--skip-env-update');
  const positional = args.filter(argument => !argument.startsWith('--'));
  const unknownFlags = args.filter(argument => argument.startsWith('--') && argument !== '--write' && argument !== '--skip-env-update');
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option: ${unknownFlags[0]}`);
  }
  const instanceDirectory = positional[0];
  if (instanceDirectory === undefined || positional.length !== 1) {
    throw new Error('Usage: npx tsx tools/migrate-routing-config.ts <instance-directory> [--write] [--skip-env-update]');
  }
  return { instanceDirectory, write, updateEnv };
}

function printHelp(): void {
  console.log('Usage: npx tsx tools/migrate-routing-config.ts <instance-directory> [--write] [--skip-env-update]');
  console.log('Dry-run is the default. API keys are always masked in terminal output.');
}

function runMigrationCli(args: readonly string[]): number {
  if (args.includes('--help')) {
    printHelp();
    return 0;
  }
  try {
    migrateRoutingConfig(parseArgs(args));
    return 0;
  } catch (error) {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(path.resolve(entryPath)).href === import.meta.url) {
  process.exitCode = runMigrationCli(process.argv.slice(2));
}
