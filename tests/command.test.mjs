import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseWindowsShell } from '../scripts/lib/command.mjs';

test('shouldUseWindowsShell enables shell for Windows cmd and bat launchers', () => {
  assert.equal(shouldUseWindowsShell('C:/toolchain/npm.cmd', false, 'win32'), true);
  assert.equal(shouldUseWindowsShell('C:/toolchain/setup.bat', false, 'win32'), true);
  assert.equal(shouldUseWindowsShell('C:/toolchain/node.exe', false, 'win32'), false);
  assert.equal(shouldUseWindowsShell('C:/toolchain/npm.cmd', true, 'win32'), true);
  assert.equal(shouldUseWindowsShell('/usr/bin/npm', false, 'linux'), false);
});
