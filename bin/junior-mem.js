#!/usr/bin/env node
// bin/junior-mem.js — npx entry point for junior-mem plugin
// Copies plugin to ~/.claude/plugins/junior-mem/, installs deps, runs init.
//
// Usage: npx junior-mem [install|uninstall|help]

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_NAME = 'junior-mem';
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'plugins', PLUGIN_NAME);
const PKG_DIR = path.resolve(__dirname, '..');

// Colors
const C = {
  red: '\x1b[0;31m', green: '\x1b[0;32m', yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m', cyan: '\x1b[0;36m', bold: '\x1b[1m',
  dim: '\x1b[2m', reset: '\x1b[0m',
};

const log = (m) => console.log(`${C.blue}  ℹ${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}  ✔${C.reset} ${m}`);
const warn = (m) => console.warn(`${C.yellow}  ⚠${C.reset} ${m}`);
const fail = (m) => console.error(`${C.red}  ✘${C.reset} ${m}`);

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
    return true;
  } catch { return false; }
}

function copyDir(src, dest) {
  const skip = new Set(['node_modules', '.git', '.DS_Store']);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function checkPrereqs() {
  const missing = [];
  if (!run('command -v jq', { silent: true })) missing.push('jq');
  if (!run('command -v node', { silent: true })) missing.push('node (>= 18)');
  if (!run('command -v bash', { silent: true })) missing.push('bash');
  if (missing.length) {
    fail(`Missing: ${missing.join(', ')}`);
    fail('Install them first, then re-run this command.');
    process.exit(1);
  }
  ok('Prerequisites met');
}

function doInstall() {
  console.log(`\n${C.bold}${C.cyan}junior-mem — Install${C.reset}\n`);

  checkPrereqs();

  // 1. Copy plugin files to persistent location
  if (fs.existsSync(INSTALL_DIR)) {
    log(`Updating existing install at ${C.dim}${INSTALL_DIR}${C.reset}`);
  } else {
    log(`Installing to ${C.dim}${INSTALL_DIR}${C.reset}`);
  }
  copyDir(PKG_DIR, INSTALL_DIR);
  ok('Plugin files copied');

  // 2. Install dependencies (better-sqlite3)
  log('Installing dependencies...');
  if (!run('npm install --omit=dev', { cwd: INSTALL_DIR })) {
    fail('npm install failed. Try manually: cd ' + INSTALL_DIR + ' && npm install');
    process.exit(1);
  }
  ok('Dependencies installed');

  // 3. Initialize knowledge directories and cron
  const initScript = path.join(INSTALL_DIR, 'scripts', 'init.sh');
  if (fs.existsSync(initScript)) {
    log('Running init (non-interactive)...');
    if (!run(`bash "${initScript}" --non-interactive`, { cwd: INSTALL_DIR })) {
      warn('Init encountered issues — run /junior-mem:init later to customize.');
    } else {
      ok('Knowledge directories initialized');
    }
  }

  // 4. Summary
  console.log(`\n${C.green}${C.bold}  Installation complete!${C.reset}\n`);
  console.log('  Next steps:');
  console.log(`    1. Restart Claude Code`);
  console.log(`    2. Plugin auto-activates with hooks, MCP tools, and commands`);
  console.log(`    3. (Optional) Run ${C.bold}/junior-mem:init${C.reset} to customize models and schedule`);
  console.log('');
}

function doUninstall() {
  console.log(`\n${C.bold}${C.red}junior-mem — Uninstall${C.reset}\n`);

  if (!fs.existsSync(INSTALL_DIR)) {
    log('Not installed.');
    return;
  }

  // Run the plugin's own uninstall script
  const uninstallScript = path.join(INSTALL_DIR, 'scripts', 'uninstall.sh');
  if (fs.existsSync(uninstallScript)) {
    run(`bash "${uninstallScript}" --yes`, { cwd: INSTALL_DIR });
  }

  // Remove plugin directory
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  ok('Plugin directory removed');
  ok('Uninstalled.');
}

function main() {
  const cmd = process.argv[2] || 'install';

  switch (cmd) {
    case 'install': case 'i':
      doInstall();
      break;
    case 'uninstall': case 'remove': case 'u':
      doUninstall();
      break;
    case 'help': case '--help': case '-h':
      console.log('Usage: npx junior-mem [command]\n');
      console.log('Commands:');
      console.log('  install     Install junior-mem plugin (default)');
      console.log('  uninstall   Remove plugin, data, and cron');
      console.log('  help        Show this help message');
      break;
    default:
      fail(`Unknown command: ${cmd}`);
      console.log('Run "npx junior-mem help" for usage.');
      process.exit(1);
  }
}

main();
