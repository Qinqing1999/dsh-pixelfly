// dsh-pixelfly — Client half.
//
// Two surfaces, one bundle:
//   1. a settings section (`settings.section`, id `pixelfly`) where the upstream, the
//      API-key ring and the retry policy are edited;
//   2. a studio page (`sidebar.panellist` icon + keyed `main` page) for generating and
//      browsing images.
//
// Every management route requires `Authorization: Bearer <token>`. The token is minted by
// the Host half per Harness process and bootstrapped from a route that itself sits behind
// the DSH connection admission, so no user input is involved. A rotated token (plugin
// reload) shows up as one 401, which re-bootstraps and retries once.

window.__ModuleLoader__.load({
  id: 'dsh-pixelfly',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'pixelfly'
    const ROUTE_BASE = '/pixelfly/api'
    const TOKEN_ROUTE = `${ROUTE_BASE}/token`
    const CONFIG_ROUTE = `${ROUTE_BASE}/config`
    const KEYS_ROUTE = `${ROUTE_BASE}/keys`
    const TEST_ROUTE = `${ROUTE_BASE}/test`
    const MODELS_ROUTE = `${ROUTE_BASE}/models`
    const GENERATE_ROUTE = `${ROUTE_BASE}/generate`
    const GALLERY_ROUTE = `${ROUTE_BASE}/gallery`
    const FILE_ROUTE = `${ROUTE_BASE}/file`
    const STATS_ROUTE = `${ROUTE_BASE}/stats`

    let tokenPromise = null
    function fetchToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(TOKEN_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`token route answered HTTP ${response.status}`))))
          .then((body) => {
            if (!body || typeof body.token !== 'string' || body.token.length < 16) throw new Error('token route returned no token')
            return body.token
          })
          .catch((error) => { tokenPromise = null; throw error })
      }
      return tokenPromise
    }

    function apiFetch(path, options = {}) {
      const request = (token) => fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(options.headers || {}), authorization: `Bearer ${token}` },
      })
      return fetchToken().then(request).then((response) => {
        if (response.status !== 401) return response
        tokenPromise = null
        return fetchToken().then(request)
      })
    }

    function readJson(response) {
      if (!response.ok) {
        return response.text().then((text) => {
          let message = `HTTP ${response.status}`
          try {
            const body = JSON.parse(text)
            if (body && typeof body.error === 'string') message = body.error
          } catch { /* not JSON; keep the status line */ }
          throw new Error(message)
        })
      }
      return response.json()
    }

    // --- language --------------------------------------------------------------------------

    const LANG_KEY = 'dsh-pixelfly:lang'
    function initialLang() {
      try {
        const saved = localStorage.getItem(LANG_KEY)
        if (saved === 'zh' || saved === 'en') return saved
      } catch { /* storage may be unavailable */ }
      try {
        const nav = (navigator.language || '').toLowerCase()
        return nav.indexOf('zh') === 0 ? 'zh' : 'en'
      } catch { return 'zh' }
    }
    const langStore = { lang: initialLang(), listeners: new Set() }
    function useLang() {
      const [lang, setLangState] = React.useState(langStore.lang)
      React.useEffect(() => {
        const listener = () => setLangState(langStore.lang)
        langStore.listeners.add(listener)
        return () => { langStore.listeners.delete(listener) }
      }, [])
      const setLang = React.useCallback((next) => {
        if (next !== 'zh' && next !== 'en') return
        langStore.lang = next
        try { localStorage.setItem(LANG_KEY, next) } catch { /* best effort */ }
        for (const listener of langStore.listeners) listener()
      }, [])
      return [lang, setLang]
    }

    const STRINGS = {
      zh: {
        nav: 'PixelFly',
        studioTitle: 'PixelFly 画室',
        studioSub: '用商汤日日新 SenseNova 图像模型出图。多 key 轮询，失败自动退避重试。',
        settingsTitle: 'PixelFly 设置',
        settingsSub: '配置上游地址、API Key 与重试策略。配置保存在本机，不会上传。',
        prompt: '提示词',
        promptPlaceholder: '描述你想要的画面，例如：黄昏时分海边灯塔，暖色逆光，电影感',
        model: '模型',
        size: '尺寸',
        count: '张数',
        watermark: '水印',
        promptExtend: '智能扩写提示词',
        generate: '生成',
        generating: '生成中…',
        generateFailed: '生成失败',
        result: '结果',
        gallery: '最近生成',
        galleryEmpty: '还没有生成过图片。',
        open: '打开',
        refresh: '刷新',
        noKey: '还没有配置 API Key，请先到「设置 → PixelFly」添加。',
        attempts: '尝试',
        elapsed: '耗时',
        upstream: '上游服务',
        baseUrl: '接口地址',
        baseUrlHint: 'OpenAI 兼容的 /v1 根地址，例如 https://token.sensenova.cn/v1',
        timeout: '超时（毫秒）',
        apiKeys: 'API Key',
        keysEmpty: '还没有 Key。',
        addKey: '添加',
        addMany: '批量添加',
        addManyHint: '每行一个，或用逗号分隔',
        keyLabel: '备注',
        keyValue: 'Key',
        test: '测试',
        testing: '测试中…',
        remove: '删除',
        clear: '全部清空',
        enabled: '已启用',
        disabled: '已停用',
        enable: '启用',
        disable: '停用',
        retry: '重试策略',
        maxAttempts: '最大尝试次数',
        baseDelay: '首次退避（毫秒）',
        maxDelay: '退避上限（毫秒）',
        cooldown: 'Key 冷却（毫秒）',
        rotateKeys: '失败后轮换 Key',
        respectRetryAfter: '遵循 Retry-After',
        defaults: '生成默认值',
        defaultModel: '默认模型',
        output: '输出',
        outputDir: '输出目录',
        outputDirHint: '留空使用插件默认目录',
        saveToDisk: '保存到磁盘',
        keepFiles: '保留文件数',
        save: '保存',
        saved: '已保存',
        saveFailed: '保存失败',
        status: '运行状态',
        keyCount: '可用 Key',
        imageRoot: '图片目录',
        lastRun: '上次生成',
        never: '暂无',
        discover: '读取上游模型列表',
        discovering: '读取中…',
        discovered: '上游可用模型',
        imageCapable: '可生成图片',
        textOnly: '仅文本，无法出图',
        copy: '复制',
        copied: '已复制',
        security: '这些 Key 只写入本机配置文件（权限 0600），页面只显示掩码。',
        needsKey: '至少添加一个 Key 才能生成。',
      },
      en: {
        nav: 'PixelFly',
        studioTitle: 'PixelFly Studio',
        studioSub: 'Generate images with SenseNova image models. Multiple keys rotate, failures back off and retry.',
        settingsTitle: 'PixelFly settings',
        settingsSub: 'Configure the upstream, API keys and the retry policy. Everything stays on this machine.',
        prompt: 'Prompt',
        promptPlaceholder: 'Describe the image, e.g. a lighthouse at dusk, warm backlight, cinematic',
        model: 'Model',
        size: 'Size',
        count: 'Count',
        watermark: 'Watermark',
        promptExtend: 'Prompt extension',
        generate: 'Generate',
        generating: 'Generating…',
        generateFailed: 'Generation failed',
        result: 'Result',
        gallery: 'Recent',
        galleryEmpty: 'Nothing generated yet.',
        open: 'Open',
        refresh: 'Refresh',
        noKey: 'No API key yet — add one in Settings → PixelFly.',
        attempts: 'Attempts',
        elapsed: 'Elapsed',
        upstream: 'Upstream',
        baseUrl: 'Base URL',
        baseUrlHint: 'OpenAI-compatible /v1 root, e.g. https://token.sensenova.cn/v1',
        timeout: 'Timeout (ms)',
        apiKeys: 'API keys',
        keysEmpty: 'No keys yet.',
        addKey: 'Add',
        addMany: 'Add many',
        addManyHint: 'One per line, or comma separated',
        keyLabel: 'Label',
        keyValue: 'Key',
        test: 'Test',
        testing: 'Testing…',
        remove: 'Remove',
        clear: 'Clear all',
        enabled: 'Enabled',
        disabled: 'Disabled',
        enable: 'Enable',
        disable: 'Disable',
        retry: 'Retry policy',
        maxAttempts: 'Max attempts',
        baseDelay: 'First backoff (ms)',
        maxDelay: 'Backoff ceiling (ms)',
        cooldown: 'Key cooldown (ms)',
        rotateKeys: 'Rotate keys on failure',
        respectRetryAfter: 'Honour Retry-After',
        defaults: 'Generation defaults',
        defaultModel: 'Default model',
        output: 'Output',
        outputDir: 'Output directory',
        outputDirHint: 'Leave empty for the plugin default',
        saveToDisk: 'Save to disk',
        keepFiles: 'Files to keep',
        save: 'Save',
        saved: 'Saved',
        saveFailed: 'Save failed',
        status: 'Runtime status',
        keyCount: 'Usable keys',
        imageRoot: 'Image directory',
        lastRun: 'Last run',
        never: 'none yet',
        discover: 'Read upstream models',
        discovering: 'Reading…',
        discovered: 'Models available upstream',
        imageCapable: 'Can generate images',
        textOnly: 'Text only — cannot generate images',
        copy: 'Copy',
        copied: 'Copied',
        security: 'Keys are written only to this machine\'s config file (mode 0600); the page shows masks only.',
        needsKey: 'Add at least one key before generating.',
      },
    }
    function useT() {
      const [lang, setLang] = useLang()
      const t = React.useCallback((key) => (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key, [lang])
      return [t, lang, setLang]
    }

    // --- styles ----------------------------------------------------------------------------

    const css = [
      '.dsh-pf-page{box-sizing:border-box;min-height:100%;padding:28px 32px 44px;overflow:auto;color:var(--dsw-alias-label-primary);}',
      '.dsh-pf-inner{max-width:900px;margin:0 auto;}',
      '.dsh-pf-inner-wide{max-width:1180px;}',
      '.dsh-pf-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;}',
      '.dsh-pf-head-main{flex:1;min-width:0;}',
      '.dsh-pf-head-side{flex:none;display:flex;align-items:center;gap:8px;}',
      '.dsh-pf-mark{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary);}',
      '.dsh-pf-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;}',
      '.dsh-pf-sub{margin:4px 0 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;margin-bottom:14px;}',
      '.dsh-pf-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;}',
      '.dsh-pf-card h2{margin:0;font-size:14px;font-weight:600;letter-spacing:.01em;}',
      '.dsh-pf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px;}',
      '.dsh-pf-field{display:flex;flex-direction:column;gap:5px;min-width:0;}',
      '.dsh-pf-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-input,.dsh-pf-select,.dsh-pf-area{box-sizing:border-box;width:100%;font:inherit;font-size:13px;line-height:1.5;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none;}',
      '.dsh-pf-input:focus,.dsh-pf-select:focus,.dsh-pf-area:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-pf-area{min-height:88px;resize:vertical;font-family:inherit;}',
      '.dsh-pf-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap;}',
      '.dsh-pf-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-pf-btn:disabled{opacity:.45;cursor:default;}',
      '.dsh-pf-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dsh-pf-btn-primary:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-pf-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dsh-pf-keys{display:flex;flex-direction:column;gap:8px;}',
      '.dsh-pf-key{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-pf-key-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.dsh-pf-key-label{font-size:12px;font-weight:600;}',
      '.dsh-pf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;}',
      '.dsh-pf-key-mask{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-key-actions{flex:none;display:flex;align-items:center;gap:6px;}',
      '.dsh-pf-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.4;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-ok{color:var(--dsw-alias-state-success-primary);}',
      '.dsh-pf-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-pf-bad{color:var(--dsw-alias-state-error-primary);}',
      '.dsh-pf-muted{color:var(--dsw-alias-state-idle-primary);}',
      '.dsh-pf-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.dsh-pf-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dsh-pf-note{margin:10px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-err{margin:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);word-break:break-word;}',
      '.dsh-pf-lang{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;}',
      '.dsh-pf-lang-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:6px 10px;cursor:pointer;}',
      '.dsh-pf-lang-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-pf-lang-btn[data-active="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
      '.dsh-pf-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}',
      '.dsh-pf-shot{position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);aspect-ratio:1/1;cursor:pointer;padding:0;appearance:none;}',
      '.dsh-pf-shot img{display:block;width:100%;height:100%;object-fit:cover;}',
      '.dsh-pf-shot-name{position:absolute;left:0;right:0;bottom:0;padding:3px 6px;font-size:10px;line-height:1.4;background:rgba(0,0,0,.55);color:#fff;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dsh-pf-preview{display:flex;flex-direction:column;gap:10px;}',
      '.dsh-pf-preview img{display:block;max-width:100%;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-pf-trace{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.5;}',
      '.dsh-pf-trace li{display:flex;gap:8px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-pf-spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-pf-spin .8s linear infinite;}',
      '@keyframes dsh-pf-spin{to{transform:rotate(360deg);}}',
      '.dsh-pf-section-gap{height:4px;}',
    ].join('')

    // --- small building blocks --------------------------------------------------------------

    function Field(props) {
      return h('label', { className: 'dsh-pf-field' },
        h('span', { className: 'dsh-pf-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dsh-pf-hint' }, props.hint) : null)
    }

    function Mark(props) {
      const size = props.size || 24
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true' },
        h('rect', { x: 7, y: 7, width: 50, height: 50, rx: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 3.2, opacity: 0.5 }),
        h('path', { d: 'M20 44l9-16 7 11 4-6 8 11z', fill: 'currentColor', opacity: 0.92 }),
        h('circle', { cx: 42, cy: 21, r: 4.4, fill: 'currentColor', opacity: 0.85 }))
    }

    function LangSwitch() {
      const [, lang, setLang] = useLang()
      return h('div', { className: 'dsh-pf-lang', role: 'group' },
        h('button', { type: 'button', className: 'dsh-pf-lang-btn', 'data-active': String(lang === 'zh'), onClick: () => setLang('zh') }, '中文'),
        h('button', { type: 'button', className: 'dsh-pf-lang-btn', 'data-active': String(lang === 'en'), onClick: () => setLang('en') }, 'EN'))
    }

    function Toast(props) {
      if (!props.message) return null
      return h('p', { className: props.tone === 'bad' ? 'dsh-pf-err' : 'dsh-pf-note' }, props.message)
    }

    // --- config state ----------------------------------------------------------------------

    function useConfig() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const reload = React.useCallback(() => {
        setState((previous) => ({ phase: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }))
        return apiFetch(CONFIG_ROUTE)
          .then(readJson)
          .then((body) => setState({ phase: 'ready', data: body, error: null }))
          .catch((error) => setState((previous) => ({ phase: 'error', data: previous.data, error: String(error && error.message || error) })))
      }, [])
      React.useEffect(() => { reload() }, [reload])
      const save = React.useCallback((patch) => {
        return apiFetch(CONFIG_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          .then(readJson)
          .then((body) => { setState({ phase: 'ready', data: body, error: null }); return body })
      }, [])
      return { state, reload, save }
    }

    // --- settings section ------------------------------------------------------------------

    function SettingsSection() {
      const [t, , ] = useT()
      const { state, reload, save } = useConfig()
      const [draft, setDraft] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testRows, setTestRows] = React.useState(null)
      const [testing, setTesting] = React.useState(false)
      const [newKey, setNewKey] = React.useState({ label: '', key: '' })
      const [bulk, setBulk] = React.useState('')
      const [models, setModels] = React.useState(null)
      const [discovering, setDiscovering] = React.useState(false)

      const config = state.data && state.data.config ? state.data.config : null
      const resolved = state.data && state.data.resolved ? state.data.resolved : null

      React.useEffect(() => {
        if (!config) return
        setDraft({
          upstream: { baseUrl: config.upstream.baseUrl, timeoutMs: config.upstream.timeoutMs },
          retry: { ...config.retry },
          models: { default: config.models.default, items: config.models.items },
          request: { size: config.request.size, n: config.request.n, watermark: config.request.watermark, promptExtend: config.request.promptExtend },
          output: { dir: config.output.dir, saveToDisk: config.output.saveToDisk, keepFiles: config.output.keepFiles },
        })
      }, [state.data && state.data.config])

      const patchDraft = React.useCallback((group, key, value) => {
        setDraft((previous) => previous === null ? previous : { ...previous, [group]: { ...previous[group], [key]: value } })
      }, [])

      const onSave = React.useCallback(() => {
        if (!draft) return
        setBusy(true)
        setToast(null)
        save(draft)
          .then(() => setToast({ tone: 'ok', message: t('saved') }))
          .catch((error) => setToast({ tone: 'bad', message: `${t('saveFailed')}: ${error.message}` }))
          .finally(() => setBusy(false))
      }, [draft, save, t])

      const keysAction = React.useCallback((body) => {
        return apiFetch(KEYS_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(readJson)
          .then(() => reload())
      }, [reload])

      const onAddKey = React.useCallback(() => {
        const key = newKey.key.trim()
        if (key.length < 8) return
        setBusy(true)
        setToast(null)
        keysAction({ action: 'add', key, label: newKey.label.trim() })
          .then(() => { setNewKey({ label: '', key: '' }); setToast({ tone: 'ok', message: t('saved') }) })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setBusy(false))
      }, [newKey, keysAction, t])

      const onAddMany = React.useCallback(() => {
        if (bulk.trim().length === 0) return
        setBusy(true)
        setToast(null)
        keysAction({ action: 'addMany', keys: bulk })
          .then(() => { setBulk(''); setToast({ tone: 'ok', message: t('saved') }) })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setBusy(false))
      }, [bulk, keysAction, t])

      const onRemoveKey = React.useCallback((id) => {
        setBusy(true)
        keysAction({ action: 'remove', id })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setBusy(false))
      }, [keysAction])

      const onToggleKey = React.useCallback((id, enabled) => {
        setBusy(true)
        keysAction({ action: 'toggle', id, enabled })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setBusy(false))
      }, [keysAction])

      const onClearKeys = React.useCallback(() => {
        setBusy(true)
        keysAction({ action: 'clear' })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setBusy(false))
      }, [keysAction])

      const onTest = React.useCallback((id) => {
        setTesting(true)
        setTestRows(null)
        apiFetch(TEST_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(id ? { id } : {}) })
          .then(readJson)
          .then((body) => setTestRows(body.results || []))
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setTesting(false))
      }, [])

      const onDiscover = React.useCallback(() => {
        setDiscovering(true)
        apiFetch(MODELS_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(readJson)
          .then((body) => {
            if (body.ok === false) throw new Error(body.error || 'model discovery failed')
            setModels(body.models || [])
          })
          .catch((error) => setToast({ tone: 'bad', message: error.message }))
          .finally(() => setDiscovering(false))
      }, [])

      const header = h('div', { className: 'dsh-pf-head' },
        h('div', { className: 'dsh-pf-mark' }, h(Mark, { size: 24 })),
        h('div', { className: 'dsh-pf-head-main' },
          h('h1', { className: 'dsh-pf-title' }, t('settingsTitle')),
          h('p', { className: 'dsh-pf-sub' }, t('settingsSub'))),
        h('div', { className: 'dsh-pf-head-side' }, h(LangSwitch, null)))

      if (state.phase === 'loading' && !config) {
        return h('div', { className: 'dsh-pf-page' }, h('style', null, css), h('div', { className: 'dsh-pf-inner' }, header,
          h('div', { className: 'dsh-pf-card' }, h('div', { className: 'dsh-pf-row' }, h('span', { className: 'dsh-pf-spin' }), h('span', { className: 'dsh-pf-muted' }, '…')))))
      }
      if (!config || !draft) {
        return h('div', { className: 'dsh-pf-page' }, h('style', null, css), h('div', { className: 'dsh-pf-inner' }, header,
          h('div', { className: 'dsh-pf-card' }, h('p', { className: 'dsh-pf-err' }, state.error || 'config unavailable'),
            h('div', { className: 'dsh-pf-row', style: { marginTop: 10 } }, h('button', { type: 'button', className: 'dsh-pf-btn', onClick: reload }, t('refresh'))))))
      }

      const keyRows = (config.apiKeys || []).map((entry) => {
        const result = testRows ? testRows.find((row) => row.id === entry.id) : null
        return h('div', { className: 'dsh-pf-key', key: entry.id },
          h('div', { className: 'dsh-pf-key-main' },
            h('span', { className: 'dsh-pf-key-label' }, entry.label),
            h('span', { className: 'dsh-pf-key-mask' }, entry.masked)),
          result ? h('span', { className: result.ok ? 'dsh-pf-badge dsh-pf-ok' : 'dsh-pf-badge dsh-pf-bad' }, result.ok ? `${result.status} · ${result.ms}ms` : (result.error || 'failed')) : null,
          h('span', { className: entry.enabled ? 'dsh-pf-badge dsh-pf-ok' : 'dsh-pf-badge dsh-pf-muted' }, entry.enabled ? t('enabled') : t('disabled')),
          h('div', { className: 'dsh-pf-key-actions' },
            h('button', { type: 'button', className: 'dsh-pf-btn', disabled: testing, onClick: () => onTest(entry.id) }, testing ? t('testing') : t('test')),
            h('button', { type: 'button', className: 'dsh-pf-btn', disabled: busy, onClick: () => onToggleKey(entry.id, !entry.enabled) }, entry.enabled ? t('disable') : t('enable')),
            h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-danger', disabled: busy, onClick: () => onRemoveKey(entry.id) }, t('remove'))))
      })

      const statusCard = h('div', { className: 'dsh-pf-card' },
        h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('status')),
          h('button', { type: 'button', className: 'dsh-pf-btn', onClick: reload }, t('refresh'))),
        h('div', { className: 'dsh-pf-keys' },
          h('div', { className: 'dsh-pf-key' },
            h('div', { className: 'dsh-pf-key-main' },
              h('span', { className: 'dsh-pf-key-label' }, t('baseUrl')),
              h('span', { className: 'dsh-pf-mono' }, resolved ? resolved.baseUrl : '')),
            h('span', { className: state.phase === 'ready' ? 'dsh-pf-badge dsh-pf-ok' : 'dsh-pf-badge' }, state.phase)),
          h('div', { className: 'dsh-pf-key' },
            h('div', { className: 'dsh-pf-key-main' },
              h('span', { className: 'dsh-pf-key-label' }, t('imageRoot')),
              h('span', { className: 'dsh-pf-mono' }, resolved ? resolved.imageRoot : ''))),
          h('div', { className: 'dsh-pf-key' },
            h('div', { className: 'dsh-pf-key-main' },
              h('span', { className: 'dsh-pf-key-label' }, t('keyCount')),
              h('span', { className: 'dsh-pf-mono' }, String(resolved ? resolved.keyCount : 0))))))

      return h('div', { className: 'dsh-pf-page' },
        h('style', null, css),
        h('div', { className: 'dsh-pf-inner' },
          header,

          h('div', { className: 'dsh-pf-card' },
            h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('upstream')),
              h('div', { className: 'dsh-pf-row' },
                h('button', { type: 'button', className: 'dsh-pf-btn', disabled: discovering, onClick: onDiscover }, discovering ? t('discovering') : t('discover')),
                h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-primary', disabled: busy, onClick: onSave }, t('save')))),
            h('div', { className: 'dsh-pf-grid' },
              h(Field, { label: t('baseUrl'), hint: t('baseUrlHint') },
                h('input', { className: 'dsh-pf-input dsh-pf-mono', value: draft.upstream.baseUrl, onChange: (event) => patchDraft('upstream', 'baseUrl', event.target.value) })),
              h(Field, { label: t('timeout') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 5000, step: 1000, value: draft.upstream.timeoutMs, onChange: (event) => patchDraft('upstream', 'timeoutMs', Number(event.target.value)) }))),
            models ? h('div', { style: { marginTop: 12 } },
              h('span', { className: 'dsh-pf-label' }, t('discovered')),
              h('div', { className: 'dsh-pf-row', style: { marginTop: 6 } },
                models.map((row) => {
                  // Only image-capable models can serve this plugin; mark them so the
                  // list is actionable instead of a flat dump of every upstream model.
                  const imageCapable = Array.isArray(row.outputModalities) && row.outputModalities.includes('image')
                  return h('span', { key: row.id, className: imageCapable ? 'dsh-pf-badge dsh-pf-ok' : 'dsh-pf-badge dsh-pf-muted', title: imageCapable ? t('imageCapable') : t('textOnly') }, row.id)
                }))) : null,
            h(Toast, { message: toast && toast.message, tone: toast && toast.tone })),

          h('div', { className: 'dsh-pf-card' },
            h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('apiKeys')),
              h('div', { className: 'dsh-pf-row' },
                h('span', { className: 'dsh-pf-badge' }, `${resolved ? resolved.keyCount : config.apiKeys.length}`),
                h('button', { type: 'button', className: 'dsh-pf-btn', disabled: testing, onClick: () => onTest(null) }, testing ? t('testing') : t('test')),
                h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-danger', disabled: busy || config.apiKeys.length === 0, onClick: onClearKeys }, t('clear')))),
            config.apiKeys.length === 0
              ? h('p', { className: 'dsh-pf-note' }, t('keysEmpty'))
              : h('div', { className: 'dsh-pf-keys' }, keyRows),
            h('div', { className: 'dsh-pf-grid', style: { marginTop: 14 } },
              h(Field, { label: t('keyLabel') },
                h('input', { className: 'dsh-pf-input', value: newKey.label, placeholder: 'Key 1', onChange: (event) => setNewKey({ ...newKey, label: event.target.value }) })),
              h(Field, { label: t('keyValue') },
                h('input', { className: 'dsh-pf-input dsh-pf-mono', type: 'password', value: newKey.key, placeholder: 'sk-…', autoComplete: 'off', onChange: (event) => setNewKey({ ...newKey, key: event.target.value }) }))),
            h('div', { className: 'dsh-pf-row', style: { marginTop: 10 } },
              h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-primary', disabled: busy || newKey.key.trim().length < 8, onClick: onAddKey }, t('addKey'))),
            h('div', { style: { marginTop: 14 } },
              h(Field, { label: t('addMany'), hint: t('addManyHint') },
                h('textarea', { className: 'dsh-pf-area dsh-pf-mono', value: bulk, onChange: (event) => setBulk(event.target.value) })),
              h('div', { className: 'dsh-pf-row', style: { marginTop: 8 } },
                h('button', { type: 'button', className: 'dsh-pf-btn', disabled: busy || bulk.trim().length === 0, onClick: onAddMany }, t('addMany')))),
            h('p', { className: 'dsh-pf-note' }, t('security'))),

          h('div', { className: 'dsh-pf-card' },
            h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('retry'))),
            h('div', { className: 'dsh-pf-grid' },
              h(Field, { label: t('maxAttempts') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 1, max: 12, step: 1, value: draft.retry.maxAttempts, onChange: (event) => patchDraft('retry', 'maxAttempts', Number(event.target.value)) })),
              h(Field, { label: t('baseDelay') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 50, step: 50, value: draft.retry.baseDelayMs, onChange: (event) => patchDraft('retry', 'baseDelayMs', Number(event.target.value)) })),
              h(Field, { label: t('maxDelay') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 1000, step: 500, value: draft.retry.maxDelayMs, onChange: (event) => patchDraft('retry', 'maxDelayMs', Number(event.target.value)) })),
              h(Field, { label: t('cooldown') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 1000, step: 1000, value: draft.retry.cooldownMs, onChange: (event) => patchDraft('retry', 'cooldownMs', Number(event.target.value)) }))),
            h('div', { className: 'dsh-pf-row', style: { marginTop: 12 } },
              h('label', { className: 'dsh-pf-check' },
                h('input', { type: 'checkbox', checked: draft.retry.rotateKeys !== false, onChange: (event) => patchDraft('retry', 'rotateKeys', event.target.checked) }),
                t('rotateKeys')),
              h('label', { className: 'dsh-pf-check' },
                h('input', { type: 'checkbox', checked: draft.retry.respectRetryAfter !== false, onChange: (event) => patchDraft('retry', 'respectRetryAfter', event.target.checked) }),
                t('respectRetryAfter')))),

          h('div', { className: 'dsh-pf-card' },
            h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('defaults'))),
            h('div', { className: 'dsh-pf-grid' },
              h(Field, { label: t('defaultModel') },
                h('select', { className: 'dsh-pf-select', value: draft.models.default, onChange: (event) => patchDraft('models', 'default', event.target.value) },
                  draft.models.items.map((row) => h('option', { key: row.id, value: row.id }, row.label || row.id)))),
              h(Field, { label: t('size') },
                h('input', { className: 'dsh-pf-input', value: draft.request.size, onChange: (event) => patchDraft('request', 'size', event.target.value) })),
              h(Field, { label: t('count') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 1, max: 4, step: 1, value: draft.request.n, onChange: (event) => patchDraft('request', 'n', Number(event.target.value)) }))),
            h('div', { className: 'dsh-pf-row', style: { marginTop: 12 } },
              h('label', { className: 'dsh-pf-check' },
                h('input', { type: 'checkbox', checked: draft.request.watermark === true, onChange: (event) => patchDraft('request', 'watermark', event.target.checked) }),
                t('watermark')),
              h('label', { className: 'dsh-pf-check' },
                h('input', { type: 'checkbox', checked: draft.request.promptExtend !== false, onChange: (event) => patchDraft('request', 'promptExtend', event.target.checked) }),
                t('promptExtend')))),

          h('div', { className: 'dsh-pf-card' },
            h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('output'))),
            h('div', { className: 'dsh-pf-grid' },
              h(Field, { label: t('outputDir'), hint: t('outputDirHint') },
                h('input', { className: 'dsh-pf-input dsh-pf-mono', value: draft.output.dir, placeholder: resolved ? resolved.outputDir : '', onChange: (event) => patchDraft('output', 'dir', event.target.value) })),
              h(Field, { label: t('keepFiles') },
                h('input', { className: 'dsh-pf-input', type: 'number', min: 0, step: 10, value: draft.output.keepFiles, onChange: (event) => patchDraft('output', 'keepFiles', Number(event.target.value)) }))),
            h('div', { className: 'dsh-pf-row', style: { marginTop: 12 } },
              h('label', { className: 'dsh-pf-check' },
                h('input', { type: 'checkbox', checked: draft.output.saveToDisk !== false, onChange: (event) => patchDraft('output', 'saveToDisk', event.target.checked) }),
                t('saveToDisk')),
              h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-primary', disabled: busy, onClick: onSave }, t('save')))),

          statusCard))
    }

    // --- studio page -----------------------------------------------------------------------

    function useObjectUrl(path) {
      const [url, setUrl] = React.useState(null)
      React.useEffect(() => {
        let revoked = null
        let cancelled = false
        if (!path) { setUrl(null); return undefined }
        apiFetch(`${FILE_ROUTE}?path=${encodeURIComponent(path)}`)
          .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`file route answered HTTP ${response.status}`))))
          .then((blob) => {
            if (cancelled) return
            const next = URL.createObjectURL(blob)
            revoked = next
            setUrl(next)
          })
          .catch(() => { if (!cancelled) setUrl(null) })
        return () => {
          cancelled = true
          if (revoked) URL.revokeObjectURL(revoked)
        }
      }, [path])
      return url
    }

    function Shot(props) {
      const url = useObjectUrl(props.file.path)
      return h('button', { type: 'button', className: 'dsh-pf-shot', title: props.file.path, onClick: () => props.onOpen(props.file) },
        url ? h('img', { src: url, alt: props.file.name }) : null,
        h('span', { className: 'dsh-pf-shot-name' }, props.file.name))
    }

    function StudioPage() {
      const [t, , ] = useT()
      const { state } = useConfig()
      const config = state.data && state.data.config ? state.data.config : null
      const resolved = state.data && state.data.resolved ? state.data.resolved : null

      const [prompt, setPrompt] = React.useState('')
      const [model, setModel] = React.useState('')
      const [size, setSize] = React.useState('')
      const [n, setN] = React.useState(1)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [files, setFiles] = React.useState([])
      const [selected, setSelected] = React.useState(null)

      React.useEffect(() => {
        if (!config) return
        setModel((previous) => previous || config.models.default)
        setSize((previous) => previous || config.request.size)
        setN((previous) => (previous && previous !== 1 ? previous : config.request.n))
      }, [state.data && state.data.config])

      const loadGallery = React.useCallback(() => {
        apiFetch(`${GALLERY_ROUTE}?limit=24`)
          .then(readJson)
          .then((body) => setFiles(body.files || []))
          .catch(() => setFiles([]))
      }, [])
      React.useEffect(() => { loadGallery() }, [loadGallery])

      const onGenerate = React.useCallback(() => {
        const text = prompt.trim()
        if (text.length === 0 || busy) return
        setBusy(true)
        setError(null)
        setResult(null)
        apiFetch(GENERATE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: text, model: model || undefined, size: size || undefined, n }),
        })
          .then(readJson)
          .then((body) => {
            setResult(body)
            setSelected(body.images && body.images.length > 0 ? body.images[0] : null)
            loadGallery()
          })
          .catch((failure) => setError(String(failure && failure.message || failure)))
          .finally(() => setBusy(false))
      }, [prompt, model, size, n, busy, loadGallery])

      const previewUrl = useObjectUrl(selected ? selected.path : null)
      const keyCount = resolved ? resolved.keyCount : 0

      const header = h('div', { className: 'dsh-pf-head' },
        h('div', { className: 'dsh-pf-mark' }, h(Mark, { size: 24 })),
        h('div', { className: 'dsh-pf-head-main' },
          h('h1', { className: 'dsh-pf-title' }, t('studioTitle')),
          h('p', { className: 'dsh-pf-sub' }, t('studioSub'))),
        h('div', { className: 'dsh-pf-head-side' },
          h('span', { className: keyCount > 0 ? 'dsh-pf-badge dsh-pf-ok' : 'dsh-pf-badge dsh-pf-warn' }, `${t('keyCount')}: ${keyCount}`),
          h(LangSwitch, null)))

      const composer = h('div', { className: 'dsh-pf-card' },
        h('div', { className: 'dsh-pf-field' },
          h('span', { className: 'dsh-pf-label' }, t('prompt')),
          h('textarea', { className: 'dsh-pf-area', value: prompt, placeholder: t('promptPlaceholder'), onChange: (event) => setPrompt(event.target.value) })),
        h('div', { className: 'dsh-pf-grid', style: { marginTop: 12 } },
          h(Field, { label: t('model') },
            h('select', { className: 'dsh-pf-select', value: model, onChange: (event) => setModel(event.target.value) },
              (config ? config.models.items : []).map((row) => h('option', { key: row.id, value: row.id }, row.label || row.id)))),
          h(Field, { label: t('size') },
            h('input', { className: 'dsh-pf-input', value: size, onChange: (event) => setSize(event.target.value) })),
          h(Field, { label: t('count') },
            h('input', { className: 'dsh-pf-input', type: 'number', min: 1, max: 4, step: 1, value: n, onChange: (event) => setN(Math.max(1, Math.min(4, Number(event.target.value) || 1))) }))),
        h('div', { className: 'dsh-pf-row', style: { marginTop: 12 } },
          h('button', { type: 'button', className: 'dsh-pf-btn dsh-pf-btn-primary', disabled: busy || prompt.trim().length === 0 || keyCount === 0, onClick: onGenerate },
            busy ? h('span', { className: 'dsh-pf-row' }, h('span', { className: 'dsh-pf-spin' }), t('generating')) : t('generate')),
          keyCount === 0 ? h('span', { className: 'dsh-pf-badge dsh-pf-warn' }, t('needsKey')) : null),
        keyCount === 0 ? h('p', { className: 'dsh-pf-note' }, t('noKey')) : null,
        error ? h('p', { className: 'dsh-pf-err' }, `${t('generateFailed')}: ${error}`) : null,
        result && result.trace ? h('ul', { className: 'dsh-pf-trace' },
          h('li', null, h('span', null, `${t('attempts')}: ${result.attempts}`), h('span', null, `${t('elapsed')}: ${result.elapsedMs}ms`)),
          result.trace.map((row, index) => h('li', { key: index },
            h('span', null, `#${row.attempt}`),
            h('span', null, row.keyId || ''),
            h('span', null, row.status ? `HTTP ${row.status}` : (row.code || 'network')),
            h('span', null, `${row.ms}ms`),
            row.message ? h('span', null, row.message) : null))) : null)

      const resultCard = selected
        ? h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('result')),
            h('span', { className: 'dsh-pf-mono' }, `${selected.width || '?'}×${selected.height || '?'} · ${Math.round((selected.bytes || 0) / 1024)}KB`)),
          h('div', { className: 'dsh-pf-preview' },
            previewUrl ? h('img', { src: previewUrl, alt: result ? result.prompt : selected.name }) : h('span', { className: 'dsh-pf-muted' }, selected.name),
            h('span', { className: 'dsh-pf-mono dsh-pf-muted' }, selected.path)))
        : null

      const galleryCard = h('div', { className: 'dsh-pf-card' },
        h('div', { className: 'dsh-pf-card-head' }, h('h2', null, t('gallery')),
          h('button', { type: 'button', className: 'dsh-pf-btn', onClick: loadGallery }, t('refresh'))),
        files.length === 0
          ? h('p', { className: 'dsh-pf-note' }, t('galleryEmpty'))
          : h('div', { className: 'dsh-pf-gallery' },
            files.map((file) => h(Shot, { key: file.path, file, onOpen: setSelected }))))

      return h('div', { className: 'dsh-pf-page' },
        h('style', null, css),
        h('div', { className: 'dsh-pf-inner dsh-pf-inner-wide' }, header, composer, resultCard, galleryCard))
    }

    function StudioIcon(props) {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 64 64', 'aria-hidden': 'true' },
        h('rect', { x: 7, y: 7, width: 50, height: 50, rx: 13, fill: 'none', stroke: props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', strokeWidth: 3.4, opacity: props.active ? 1 : 0.72 }),
        h('path', { d: 'M20 44l9-16 7 11 4-6 8 11z', fill: props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', opacity: 0.92 }),
        h('circle', { cx: 42, cy: 21, r: 4.4, fill: props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', opacity: 0.85 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'pixelfly',
          order: 42,
          label: () => (langStore.lang === 'zh' ? 'PixelFly' : 'PixelFly'),
        }, SettingsSection))
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 56,
          label: () => 'PixelFly',
        }, StudioIcon))
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, StudioPage))
      },
    }
  },
})
