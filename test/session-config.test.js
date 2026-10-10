const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SessionConfig = require('../public/session-config');

test('quick-launch defaults pick up newly defined settings without another option-copying list', async () => {
  const field = { key: 'futureOption', label: 'Future option', type: 'text', default: '' };
  SessionConfig.FIELDS.claude.push(field);
  try {
    const context = vm.createContext({ SessionConfig, window: { api: {
      getEffectiveSettings: async () => ({ permissionMode: null, chrome: false, addDirs: '',
        codexModel: 'model', futureOption: 'future value' }),
    } } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/dialogs.js'), 'utf8'), context);
    const options = await context.resolveDefaultSessionOptions({ projectPath: '/project' });
    assert.equal(options.futureOption, 'future value');
    assert.equal(options.permissionMode, null);
    assert.equal(options.chrome, false);
    assert.equal(options.addDirs, '');
    assert.equal(options.codexModel, 'model');
  } finally { SessionConfig.FIELDS.claude.pop(); }
});

test('custom false, null and empty values beat folder defaults; untouched fields follow changes', () => {
  const overrides = { permissionMode: null, dangerouslySkipPermissions: false, chrome: false, addDirs: '' };
  const defaults = { permissionMode: 'bypassPermissions', dangerouslySkipPermissions: true, chrome: true,
    addDirs: '/inherited', preLaunchCmd: 'old-prefix', codexModel: 'unrelated' };
  const options = SessionConfig.resolveOptions('claude', defaults, overrides);
  for (const [key, value] of Object.entries(overrides)) assert.equal(options[key], value);
  assert.equal(options.preLaunchCmd, 'old-prefix');
  assert.equal(options.codexModel, undefined);
  assert.equal(SessionConfig.resolveOptions('claude', { ...defaults, preLaunchCmd: 'new-prefix' }, overrides).preLaunchCmd, 'new-prefix');
  assert.equal(SessionConfig.resolveOptions('claude', defaults, {}).chrome, true, 'reset to inheritance');
});

test('configuration rejects cross-CLI fields, internal launch flags and invalid values', () => {
  for (const input of [{ permissionMode: 'plan' }, { worktree: true }, { forkFrom: 'id' }]) {
    assert.throws(() => SessionConfig.normalizeOverrides('codex', input), /no admitido/);
  }
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { chrome: 'false' }), /activado o desactivado/);
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { codexSandbox: 'unknown' }), /Valor no válido para Sandbox/);
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { preLaunchCmd: 'one\ntwo' }), /una sola línea/);
});

test('optional settings wait behind More options until they hold a value', () => {
  const empty = SessionConfig.resolveOptions('claude', {}, {});
  assert.deepEqual(SessionConfig.fieldsBehindMore('claude', empty), ['model', 'effort', 'allowedTools', 'appendSystemPrompt', 'preLaunchCmd', 'addDirs']);
  const filled = SessionConfig.resolveOptions('claude', { preLaunchCmd: 'aws-vault exec prod --' }, { model: 'opus' });
  assert.deepEqual(SessionConfig.fieldsBehindMore('claude', filled), ['effort', 'allowedTools', 'appendSystemPrompt', 'addDirs'],
    'a saved model and a folder pre-launch command stay in view');
  assert.deepEqual(SessionConfig.fieldsBehindMore('codex', SessionConfig.resolveOptions('codex', {}, {})), ['codexModel', 'codexEffort', 'preLaunchCmd', 'addDirs']);
  assert.ok(!SessionConfig.fieldsBehindMore('claude', empty).includes('permissionMode'), 'the main settings are never tucked away');
});

test('model and effort are per-CLI settings that default to unset', () => {
  const claude = SessionConfig.resolveOptions('claude', {}, {});
  assert.equal(claude.model, '');
  assert.equal(claude.effort, '');
  assert.equal(SessionConfig.resolveOptions('codex', {}, {}).codexEffort, '');
  assert.deepEqual(SessionConfig.normalizeOverrides('claude', { model: ' opus ', effort: 'max' }), { model: 'opus', effort: 'max' });
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { effort: 'ultra' }), /Valor no válido para Esfuerzo/);
  assert.equal(SessionConfig.normalizeOverrides('codex', { codexEffort: 'ultra' }).codexEffort, 'ultra');
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { effort: 'high' }), /no admitido/);
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { codexEffort: 'high' }), /no admitido/);
});

test('additional Claude instructions preserve multiline text through settings and launch', () => {
  const appendSystemPrompt = 'First line.\n  Indented instructions.\n';
  const options = SessionConfig.resolveOptions('claude', {}, { appendSystemPrompt, allowedTools: 'Read,Write' });
  assert.equal(options.appendSystemPrompt, appendSystemPrompt);
  const args = require('../harnesses/claude').buildLaunchArgs({ sessionId: 'test', isNew: true, options });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], appendSystemPrompt);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Write');
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { appendSystemPrompt: 'bad\x00prompt' }), /caracteres no permitidos/);
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { allowedTools: 'Read' }), /no admitido/);
});
