// Shared definitions, validation and inheritance for session settings.
// Add supported fields here once; both configuration forms use this registry.
(function (root) {
  const PERMISSION_MODES = [
    { value: null, label: 'Predeterminado', desc: 'Pide confirmación para todas las acciones' },
    { value: 'auto', label: 'Automático', desc: 'El clasificador permite el trabajo rutinario y se detiene ante acciones riesgosas' },
    { value: 'acceptEdits', label: 'Aceptar ediciones', desc: 'Acepta ediciones de archivos automáticamente, pide confirmación para lo demás' },
    { value: 'plan', label: 'Modo plan', desc: 'Exploración de solo lectura, sin escrituras' },
    { value: 'dontAsk', label: 'No preguntar', desc: 'Rechaza automáticamente las herramientas no permitidas explícitamente' },
    { value: 'bypassPermissions', label: 'Omitir', desc: 'Acepta automáticamente todas las llamadas a herramientas' },
  ];
  const CODEX_SANDBOX_MODES = [
    { value: '', label: 'Predeterminado', desc: 'Usa la configuración propia de Codex' },
    { value: 'read-only', label: 'Solo lectura', desc: 'Sin escrituras ni comandos que cambien algo' },
    { value: 'workspace-write', label: 'Escritura en el espacio de trabajo', desc: 'Escribe dentro del directorio del proyecto' },
    { value: 'danger-full-access', label: 'Acceso total', desc: 'Sin sandbox' },
  ];
  const CODEX_APPROVAL_POLICIES = [
    { value: '', label: 'Predeterminado', desc: 'Usa la configuración propia de Codex' },
    { value: 'on-request', label: 'Bajo solicitud', desc: 'Codex decide cuándo preguntar' },
    { value: 'never', label: 'Nunca', desc: 'Nunca pregunta; los fallos vuelven al modelo' },
  ];
  // Effort levels. Claude's are the ones `claude --help` lists. Codex's are
  // the union over its model catalog; each model supports a subset, and the
  // form narrows the choice to what the chosen model accepts.
  const CLAUDE_EFFORTS = [
    { value: '', label: 'Predeterminado' }, { value: 'low', label: 'Bajo' }, { value: 'medium', label: 'Medio' },
    { value: 'high', label: 'Alto' }, { value: 'xhigh', label: 'Muy alto' }, { value: 'max', label: 'Máximo' },
  ];
  const CODEX_EFFORTS = [...CLAUDE_EFFORTS, { value: 'ultra', label: 'Ultra' }];
  const FIELDS = {
    claude: [
      { key: 'permissionMode', label: 'Modo de permisos', type: 'permission', default: null, choices: PERMISSION_MODES },
      { key: 'dangerouslySkipPermissions', type: 'boolean', default: false, hidden: true },
      { key: 'model', label: 'Modelo', type: 'text', default: '', more: true, placeholder: 'predeterminado', suggestions: ['fable', 'opus', 'sonnet'], description: 'Vacío usa el predeterminado de Claude. Un alias o un nombre completo de modelo' },
      { key: 'effort', label: 'Esfuerzo', type: 'select', default: '', more: true, choices: CLAUDE_EFFORTS, description: 'Predeterminado usa la configuración propia de Claude' },
      { key: 'allowedTools', label: 'Herramientas permitidas', type: 'text', default: '', more: true, wide: true, description: 'Herramientas permitidas sin pedir permiso (separadas por comas)' },
      { key: 'appendSystemPrompt', label: 'Prompt de sistema adicional', type: 'textarea', default: '', more: true, wide: true, description: 'Instrucciones añadidas al prompt de sistema de Claude' },
      { key: 'worktree', label: 'Worktree', type: 'boolean', default: false, description: 'Ejecuta cada nueva sesión en un worktree de git aislado' },
      { key: 'worktreeName', label: 'Nombre del worktree', type: 'text', default: '', placeholder: 'nombre (opcional)' },
      { key: 'chrome', label: 'Chrome', type: 'boolean', default: false, description: 'Activa la automatización del navegador Chrome' },
    ],
    codex: [
      { key: 'codexSandbox', label: 'Sandbox', type: 'select', default: '', choices: CODEX_SANDBOX_MODES, description: 'Qué puede tocar Codex' },
      { key: 'codexApproval', label: 'Aprobación', type: 'select', default: '', choices: CODEX_APPROVAL_POLICIES, description: 'Cuándo pide Codex confirmación antes de ejecutar un comando' },
      { key: 'codexModel', label: 'Modelo', type: 'text', default: '', more: true, placeholder: 'predeterminado', catalog: 'codex', description: 'Vacío usa el predeterminado de Codex' },
      { key: 'codexEffort', label: 'Esfuerzo de razonamiento', type: 'select', default: '', more: true, choices: CODEX_EFFORTS, modelField: 'codexModel', description: 'Predeterminado usa la configuración propia de Codex' },
      { key: 'dangerouslySkipPermissions', label: 'Omitir aprobaciones y sandbox', type: 'boolean', default: false, description: 'Desactiva las solicitudes de permiso y las restricciones del sandbox' },
    ],
  };
  const COMMON_FIELDS = [
    { key: 'preLaunchCmd', label: 'Comando previo al inicio', type: 'text', default: '', more: true, wide: true, placeholder: 'ej. aws-vault exec profile --', description: 'Se antepone al comando de la CLI' },
    { key: 'addDirs', label: 'Directorios adicionales', type: 'text', default: '', more: true, wide: true, placeholder: '/ruta/dir1, /ruta/dir2', description: 'Directorios extra (separados por comas). Los adjuntos del proyecto se incluyen automáticamente.' },
  ];
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function fieldsFor(runtime) { return [...(FIELDS[runtime] || []), ...COMMON_FIELDS]; }

  /**
   * Keys of the optional fields (more: true) that wait behind "More options":
   * those without a value. A value from saved overrides or folder defaults
   * keeps its field in view, so nothing already set is ever tucked away.
   */
  function fieldsBehindMore(runtime, values = {}) {
    const hasValue = (field, value) => field.type === 'boolean' ? value === true : value !== undefined && value !== null && value !== '';
    return fieldsFor(runtime).filter(f => f.more && !f.hidden && !hasValue(f, values[f.key])).map(f => f.key);
  }

  function normalizeOverrides(runtime, input = {}) {
    if (!isObject(input)) throw new Error('Los ajustes de sesión deben ser un objeto');
    const fields = new Map(fieldsFor(runtime).map(f => [f.key, f]));
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const field = fields.get(key);
      if (!field) throw new Error(`Ajuste no admitido para ${runtime}: ${key}`);
      if (field.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${key} debe ser activado o desactivado`);
        out[key] = value;
      } else if (field.choices) {
        if (!field.choices.some(c => c.value === value)) throw new Error(`Valor no válido para ${field.label}`);
        out[key] = value;
      } else {
        if (typeof value !== 'string') throw new Error(`${field.label} debe ser texto`);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${field.label} contiene caracteres no permitidos`);
        if (field.type !== 'textarea' && /[\r\n]/.test(value)) throw new Error(`${field.label} debe ser una sola línea`);
        out[key] = field.type === 'textarea' ? value : value.trim();
      }
    }
    return out;
  }

  function resolveOptions(runtime, defaults = {}, overrides = {}) {
    const clean = normalizeOverrides(runtime, overrides);
    const out = {};
    for (const field of fieldsFor(runtime)) {
      let value = own(clean, field.key) ? clean[field.key] : defaults?.[field.key];
      // Null means a CLI's own default for selects/text, and off for toggles.
      if (value === undefined) value = field.default;
      if (value === null && field.type !== 'permission') value = field.type === 'boolean' ? false : '';
      out[field.key] = value;
    }
    return normalizeOverrides(runtime, out);
  }

  const api = { PERMISSION_MODES, CODEX_SANDBOX_MODES, CODEX_APPROVAL_POLICIES, CLAUDE_EFFORTS, CODEX_EFFORTS, FIELDS, COMMON_FIELDS,
    fieldsFor, fieldsBehindMore, normalizeOverrides, resolveOptions, own };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
