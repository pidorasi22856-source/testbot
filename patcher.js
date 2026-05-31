'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');
const { logPatch, getLastPatchEntry } = require('./db');

const KIRO_DIR     = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Kiro');
const PRODUCT_JSON = path.join(KIRO_DIR, 'resources', 'app', 'product.json');
const ARGV_JSON    = path.join(os.homedir(), '.kiro', 'argv.json');

// ─── Patch definitions ────────────────────────────────────────────────────────

const PATCHES = [
  {
    id:          'disable_telemetry',
    label:       'Disable Telemetry',
    description: 'Sets enableTelemetry=false in product.json. Stops sending usage events to Kiro/Microsoft telemetry servers.',
    file:        PRODUCT_JSON,
    type:        'json_key',
    key:         'enableTelemetry',
    newValue:    false,
  },
  {
    id:          'block_autoupdate',
    label:       'Block Auto-Updates',
    description: 'Clears updateUrl in product.json. Prevents Kiro from downloading and applying updates automatically.',
    file:        PRODUCT_JSON,
    type:        'json_key',
    key:         'updateUrl',
    newValue:    '',
  },
  {
    id:          'disable_crash_reporter',
    label:       'Disable Crash Reporter',
    description: 'Sets enable-crash-reporter=false in argv.json. Stops crash dumps from being sent.',
    file:        ARGV_JSON,
    type:        'jsonc_key',
    key:         'enable-crash-reporter',
    newValue:    false,
  },
  {
    id:          'reset_crash_reporter_id',
    label:       'Reset Crash Reporter ID',
    description: 'Replaces crash-reporter-id with a fresh UUID in argv.json. Breaks any device-level correlation.',
    file:        ARGV_JSON,
    type:        'jsonc_key',
    key:         'crash-reporter-id',
    newValue:    '__NEW_UUID__', // resolved at apply time
  },
];

// ─── JSONC helpers (preserves comments) ──────────────────────────────────────

function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip single-line comments for parsing only
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  return { raw, parsed: JSON.parse(stripped) };
}

function setJsoncKey(raw, key, value) {
  // Replace value in raw JSONC string, preserving comments and formatting
  const valueStr = JSON.stringify(value);
  // Match "key": <any value> (handles strings, booleans, numbers)
  const re = new RegExp(`("${key}"\\s*:\\s*)([^,\\n\\r}]+)`, 'g');
  if (!re.test(raw)) {
    throw new Error(`Key "${key}" not found in JSONC file`);
  }
  return raw.replace(re, `$1${valueStr}`);
}

// ─── Core apply/revert ────────────────────────────────────────────────────────

function applyPatch(patchId) {
  const patch = PATCHES.find(p => p.id === patchId);
  if (!patch) throw new Error(`Unknown patch: ${patchId}`);

  if (!fs.existsSync(patch.file)) {
    throw new Error(`File not found: ${patch.file}`);
  }

  // Backup before first patch
  const backupPath = patch.file + '.kiro-manager.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(patch.file, backupPath);
  }

  const raw = fs.readFileSync(patch.file, 'utf8');
  let newValue = patch.newValue;
  if (newValue === '__NEW_UUID__') newValue = uuidv4();

  let newRaw;
  let oldValue;

  if (patch.type === 'json_key') {
    const obj = JSON.parse(raw);
    oldValue = obj[patch.key];
    obj[patch.key] = newValue;
    newRaw = JSON.stringify(obj, null, '\t');
  } else if (patch.type === 'jsonc_key') {
    const { parsed } = readJsonc(patch.file);
    oldValue = parsed[patch.key];
    newRaw = setJsoncKey(raw, patch.key, newValue);
  }

  fs.writeFileSync(patch.file, newRaw, 'utf8');
  logPatch(patchId, patch.file, 'apply', JSON.stringify(oldValue), JSON.stringify(newValue));

  return { patchId, oldValue, newValue };
}

function revertPatch(patchId) {
  const patch = PATCHES.find(p => p.id === patchId);
  if (!patch) throw new Error(`Unknown patch: ${patchId}`);

  const backupPath = patch.file + '.kiro-manager.bak';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, patch.file);
    logPatch(patchId, patch.file, 'revert', null, null);
    return { patchId, restored: 'backup' };
  }

  // Fallback: restore from patch_log old_value
  const last = getLastPatchEntry(patchId);
  if (!last || last.old_value === null) throw new Error('No backup or log entry to revert from');

  const raw = fs.readFileSync(patch.file, 'utf8');
  const oldValue = JSON.parse(last.old_value);
  let newRaw;

  if (patch.type === 'json_key') {
    const obj = JSON.parse(raw);
    obj[patch.key] = oldValue;
    newRaw = JSON.stringify(obj, null, '\t');
  } else if (patch.type === 'jsonc_key') {
    newRaw = setJsoncKey(raw, patch.key, oldValue);
  }

  fs.writeFileSync(patch.file, newRaw, 'utf8');
  logPatch(patchId, patch.file, 'revert', last.new_value, last.old_value);
  return { patchId, restored: 'log' };
}

// ─── Status check ─────────────────────────────────────────────────────────────

function getPatchesStatus() {
  return PATCHES.map(patch => {
    let applied   = false;
    let current   = null;
    let fileExists = fs.existsSync(patch.file);
    let error     = null;

    if (fileExists) {
      try {
        let parsed;
        if (patch.type === 'json_key') {
          parsed = JSON.parse(fs.readFileSync(patch.file, 'utf8'));
        } else {
          parsed = readJsonc(patch.file).parsed;
        }
        current = parsed[patch.key];

        // Determine "applied" state
        if (patch.newValue === '__NEW_UUID__') {
          // For UUID reset: applied if value differs from any known original
          const last = getLastPatchEntry(patch.id);
          applied = !!(last && last.action === 'apply');
        } else {
          applied = current === patch.newValue;
        }
      } catch (e) {
        error = e.message;
      }
    } else {
      error = 'File not found';
    }

    return {
      id:          patch.id,
      label:       patch.label,
      description: patch.description,
      file:        patch.file,
      key:         patch.key,
      targetValue: patch.newValue === '__NEW_UUID__' ? '<new UUID>' : patch.newValue,
      currentValue: current,
      applied,
      fileExists,
      hasBackup:   fs.existsSync(patch.file + '.kiro-manager.bak'),
      error,
    };
  });
}

module.exports = { PATCHES, applyPatch, revertPatch, getPatchesStatus };
