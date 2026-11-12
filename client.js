window.__ModuleLoader__.load({
  id: 'dsh-pixelfly',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'pixelfly'
    const API = '/pixelfly/api'

    // -----------------------------------------------------------------------
    // transport
    // -----------------------------------------------------------------------

    let tokenPromise = null

    function fetchToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(`${API}/token`, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`token ${response.status}`))))
          .then((body) => body.token)
          .catch((error) => {
            tokenPromise = null
            throw error
          })
      }
      return tokenPromise
    }

    async function api(path, options = {}) {
      const token = await fetchToken()
      const request = {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        credentials: 'same-origin',
        headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
        signal: options.signal,
      }
      if (options.body !== undefined) {
        request.headers['content-type'] = 'application/json'
        request.body = JSON.stringify(options.body)
      }
      const response = await fetch(`${API}/${path}`, request)
      const text = await response.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!response.ok || (body && body.ok === false)) {
        const error = new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`)
        error.code = body?.code ?? `http_${response.status}`
        error.status = response.status
        throw error
      }
      return body
    }

    // Assets need the bearer token, so they are fetched into blob URLs and cached.
    const assetCache = new Map()
    const assetPending = new Map()

    function loadAsset(id) {
      if (!id) return Promise.resolve(null)
      if (assetCache.has(id)) return Promise.resolve(assetCache.get(id))
      if (assetPending.has(id)) return assetPending.get(id)
      const pending = fetchToken()
        .then((token) => fetch(`${API}/asset?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' }))
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`asset ${response.status}`))))
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          assetCache.set(id, url)
          assetPending.delete(id)
          return url
        })
        .catch((error) => {
          assetPending.delete(id)
          throw error
        })
      assetPending.set(id, pending)
      return pending
    }

    function useAssetUrl(id) {
      const [url, setUrl] = useState(() => (id && assetCache.get(id)) || null)
      useEffect(() => {
        let live = true
        if (!id) {
          setUrl(null)
          return undefined
        }
        const cached = assetCache.get(id)
        if (cached) {
          setUrl(cached)
          return undefined
        }
        setUrl(null)
        loadAsset(id).then(
          (value) => live && setUrl(value),
          () => live && setUrl(null),
        )
        return () => {
          live = false
        }
      }, [id])
      return url
    }

    // -----------------------------------------------------------------------
    // language
    // -----------------------------------------------------------------------

    const LANG_KEY = 'dsh-pixelfly:lang'

    function readLang() {
      try {
        const stored = window.localStorage.getItem(LANG_KEY)
        if (stored === 'zh' || stored === 'en') return stored
      } catch {
        /* storage can be blocked */
      }
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '') ? 'zh' : 'en'
    }

    let lang = readLang()
    const langListeners = new Set()

    function setLang(next) {
      lang = next === 'zh' ? 'zh' : 'en'
      try {
        window.localStorage.setItem(LANG_KEY, lang)
      } catch {
        /* ignore */
      }
      for (const listener of langListeners) listener(lang)
    }

    function useLang() {
      const [value, setValue] = useState(lang)
      useEffect(() => {
        const listener = (next) => setValue(next)
        langListeners.add(listener)
        setValue(lang)
        return () => langListeners.delete(listener)
      }, [])
      return [value, setLang]
    }

    const STRINGS = {
      zh: {
        settingsNav: 'PixelFly',
        brand: 'PixelFly 画室',
        tagline: '一个工作台，一条版本树：文生图、提示词改图、局部重绘、参考图融合、批量出图、图片改字、扩图、去水印。',
        open: '打开',
        cancel: '取消',
        empty: '还没有版本。写一句提示词开始创作。',
        remove: '删除',
        star: '收藏',
        unstar: '取消收藏',
        clearHistory: '清空历史',
        clearHistoryConfirm: '清空全部版本？图片文件会一起删除。',
        versions: '版本',
        version: '版本',
        conversation: '对话',
        batch: '批量',
        prompt: '提示词',
        promptPlaceholder: '描述你想要的画面，或说明这次要怎么改…',
        generate: '生成',
        send: '执行',
        model: '图像模型',
        visionModel: '视觉模型',
        size: '尺寸',
        count: '张数',
        style: '统一风格',
        stylePlaceholder: '可选：给之后每次生成追加一段统一风格描述',
        working: '处理中…',
        cancelRun: '取消',
        result: '结果',
        before: '修改前',
        after: '修改后',
        compare: '对比',
        close: '关闭',
        download: '下载',
        zoomIn: '放大',
        zoomOut: '缩小',
        fit: '适应窗口',
        selectRegion: '在图上拖拽框选区域',
        selection: '选区',
        clearSelection: '清除选区',
        apply: '应用',
        reference: '参考图',
        pickReference: '选择参考图',
        dropHint: '把参考图拖到画布上即可融合',
        ops: {
          text2image: '文生图',
          edit: '提示词改图',
          localEdit: '局部重绘',
          fusion: '参考图融合',
          batchVariables: '变量批量',
          batchList: '提示词批量',
          outpaint: '扩图',
          enhance: '画质增强',
          removeWatermark: '去水印',
          removeBackground: '去背景',
          removeElement: '元素移除',
          extractAsset: '素材提取',
          editText: '图片改字',
          colorize: '上色与线稿',
        },
        groups: { create: '创作', edit: '编辑', remove: '去除', extract: '提取', style: '风格' },
        preset: '预设',
        kind: '提取类型',
        mode: '模式',
        palette: '配色',
        strength: '强度',
        preset_box: '移除框选区域',
        preset_bystanders: '移除路人',
        preset_clutter: '清理杂物',
        preset_text: '清除全部文字',
        preset_tidy: '整理房间',
        kind_box: '方框素材',
        kind_clothing: '服饰',
        kind_accessory: '配饰',
        kind_pattern: '表面花纹',
        kind_background: '背景',
        colour_mono: '单色上色',
        colour_lineart: '线稿上色',
        colour_toLineart: '照片转线稿',
        fusion_basic: '基础融合',
        fusion_outfit: '换装',
        fusion_pose: '迁移姿势',
        fusion_group: '合照',
        instructions: '指令',
        values: '变量值',
        prompts: '提示词列表',
        variablesHint: '用 [变量] 标记要替换的位置，每行一组值，逗号分隔',
        listHint: '每行一条提示词，行数就是出图数量',
        unifiedStyle: '统一风格',
        preview: '预览数量',
        regions: '文字区域',
        recognise: '识别图中文字',
        replaceWith: '替换为',
        clearText: '清除',
        addRegion: '手动添加区域',
        keep: '保留区域',
        keepHint: '点选要保留的人物或物体，其余移除',
        libraryPrompts: '提示词库',
        usePrompt: '使用',
        removePrompt: '移除',
        addPrompt: '收藏当前提示词',
        noVersions: '还没有版本。写一句提示词开始创作。',
        failed: '失败',
        attempts: '尝试',
        elapsed: '耗时',
        keyUsed: 'Key',
        keyCount: '可用 Key',
        settings: 'PixelFly 设置',
        upstream: '上游服务',
        baseUrl: '接口地址',
        provider: '协议',
        timeout: '请求超时（毫秒）',
        visionTimeout: '视觉请求超时（毫秒）',
        discover: '读取上游模型',
        discovered: '已读取',
        modelsTitle: '模型',
        defaultImageModel: '默认图像模型',
        defaultVisionModel: '默认视觉模型',
        imageCapable: '可生成图片',
        visionCapable: '可识图',
        textOnly: '仅文本',
        keysTitle: 'API Key',
        keysHint: '这些 Key 只写入本机配置文件（权限 0600），页面只显示掩码。',
        addKey: '添加',
        addMany: '批量添加',
        bulkHint: '每行一个，或用逗号分隔',
        label: '备注',
        test: '测试',
        enable: '启用',
        disable: '停用',
        enabled: '已启用',
        disabled: '已停用',
        clearKeys: '清空全部',
        retryTitle: '重试策略',
        maxAttempts: '最大尝试次数',
        baseDelay: '首次退避（毫秒）',
        maxDelay: '退避上限（毫秒）',
        cooldown: 'Key 冷却（毫秒）',
        rotate: '失败后轮换 Key',
        respectAfter: '遵循 Retry-After',
        limitsTitle: '限制',
        maxBatch: '批量上限',
        visionMaxSide: '视觉图片边长',
        statusTitle: '状态',
        save: '保存',
        saved: '已保存',
        testOk: '可用',
        testFail: '不可用',
      },
      en: {
        settingsNav: 'PixelFly',
        brand: 'PixelFly Studio',
        tagline: 'One workspace, one version tree: text to image, prompt edits, regional repaint, reference fusion, batch runs, in-image text, outpainting, watermark removal.',
        open: 'Open',
        cancel: 'Cancel',
        empty: 'Nothing here yet. Write a prompt to start.',
        remove: 'Delete',
        star: 'Star',
        unstar: 'Unstar',
        clearHistory: 'Clear history',
        clearHistoryConfirm: 'Clear every version? The image files are deleted too.',
        versions: 'Versions',
        version: 'Version',
        conversation: 'Chat',
        batch: 'Batch',
        prompt: 'Prompt',
        promptPlaceholder: 'Describe the picture you want, or what to change…',
        generate: 'Generate',
        send: 'Run',
        model: 'Image model',
        visionModel: 'Vision model',
        size: 'Size',
        count: 'Count',
        style: 'House style',
        stylePlaceholder: 'Optional: a style line appended to every later prompt',
        working: 'Working…',
        cancelRun: 'Cancel',
        result: 'Result',
        before: 'Before',
        after: 'After',
        compare: 'Compare',
        close: 'Close',
        download: 'Download',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        fit: 'Fit',
        selectRegion: 'Drag on the image to select an area',
        selection: 'Selection',
        clearSelection: 'Clear selection',
        apply: 'Apply',
        reference: 'Reference',
        pickReference: 'Pick reference',
        dropHint: 'Drop a reference image on the canvas to fuse',
        ops: {
          text2image: 'Text to image',
          edit: 'Prompt edit',
          localEdit: 'Regional repaint',
          fusion: 'Reference fusion',
          batchVariables: 'Variable batch',
          batchList: 'Prompt list batch',
          outpaint: 'Outpaint',
          enhance: 'Enhance',
          removeWatermark: 'Remove watermark',
          removeBackground: 'Remove background',
          removeElement: 'Remove element',
          extractAsset: 'Extract asset',
          editText: 'Edit text',
          colorize: 'Colour and line art',
        },
        groups: { create: 'Create', edit: 'Edit', remove: 'Remove', extract: 'Extract', style: 'Style' },
        preset: 'Preset',
        kind: 'Asset kind',
        mode: 'Mode',
        palette: 'Palette',
        strength: 'Strength',
        preset_box: 'Remove boxed area',
        preset_bystanders: 'Remove bystanders',
        preset_clutter: 'Clear clutter',
        preset_text: 'Clear all text',
        preset_tidy: 'Tidy the room',
        kind_box: 'Boxed object',
        kind_clothing: 'Clothing',
        kind_accessory: 'Accessory',
        kind_pattern: 'Surface pattern',
        kind_background: 'Background',
        colour_mono: 'Colourise',
        colour_lineart: 'Colourise line art',
        colour_toLineart: 'Photo to line art',
        fusion_basic: 'Basic fusion',
        fusion_outfit: 'Change outfit',
        fusion_pose: 'Transfer pose',
        fusion_group: 'Group photo',
        instructions: 'Instructions',
        values: 'Values',
        prompts: 'Prompt list',
        variablesHint: 'Mark spots with [variable], one set of values per line, comma separated',
        listHint: 'One prompt per line; the line count is the output count',
        unifiedStyle: 'Unified style',
        preview: 'Preview count',
        regions: 'Text regions',
        recognise: 'Read text in image',
        replaceWith: 'Replace with',
        clearText: 'Clear',
        addRegion: 'Add region',
        keep: 'Keep',
        keepHint: 'Click the people or objects to keep; everything else is removed',
        libraryPrompts: 'Prompt library',
        usePrompt: 'Use',
        removePrompt: 'Remove',
        addPrompt: 'Save current prompt',
        noVersions: 'Nothing here yet. Write a prompt to start.',
        failed: 'Failed',
        attempts: 'Attempts',
        elapsed: 'Took',
        keyUsed: 'Key',
        keyCount: 'Usable keys',
        settings: 'PixelFly settings',
        upstream: 'Upstream',
        baseUrl: 'Base URL',
        provider: 'Protocol',
        timeout: 'Request timeout (ms)',
        visionTimeout: 'Vision timeout (ms)',
        discover: 'Read upstream models',
        discovered: 'Loaded',
        modelsTitle: 'Models',
        defaultImageModel: 'Default image model',
        defaultVisionModel: 'Default vision model',
        imageCapable: 'Generates images',
        visionCapable: 'Reads images',
        textOnly: 'Text only',
        keysTitle: 'API keys',
        keysHint: 'Keys are written only to the local config file (mode 0600); the page shows masks.',
        addKey: 'Add',
        addMany: 'Bulk add',
        bulkHint: 'One per line, or comma separated',
        label: 'Label',
        test: 'Test',
        enable: 'Enable',
        disable: 'Disable',
        enabled: 'Enabled',
        disabled: 'Disabled',
        clearKeys: 'Clear all',
        retryTitle: 'Retry policy',
        maxAttempts: 'Max attempts',
        baseDelay: 'First backoff (ms)',
        maxDelay: 'Backoff cap (ms)',
        cooldown: 'Key cooldown (ms)',
        rotate: 'Rotate keys on failure',
        respectAfter: 'Honour Retry-After',
        limitsTitle: 'Limits',
        maxBatch: 'Batch cap',
        visionMaxSide: 'Vision image side',
        statusTitle: 'Status',
        save: 'Save',
        saved: 'Saved',
        testOk: 'OK',
        testFail: 'Failed',
      },
    }

    function useT() {
      const [value] = useLang()
      return useCallback((key) => {
        const table = STRINGS[value] ?? STRINGS.en
        const fallback = STRINGS.en
        return table[key] ?? fallback[key] ?? key
      }, [value])
    }

    function useOpLabel() {
      const [value] = useLang()
      return useCallback((id) => STRINGS[value]?.ops?.[id] ?? STRINGS.en.ops[id] ?? id, [value])
    }

    function LangSwitch() {
      const [value, setValue] = useLang()
      return h('div', { className: 'dsh-pf-lang', role: 'group', 'aria-label': 'Language' },
        h('button', { type: 'button', className: 'dsh-pf-lang-btn', 'data-active': String(value === 'zh'), onClick: () => setValue('zh') }, '中文'),
        h('button', { type: 'button', className: 'dsh-pf-lang-btn', 'data-active': String(value === 'en'), onClick: () => setValue('en') }, 'EN'),
      )
    }

    // -----------------------------------------------------------------------
    // styles
    // -----------------------------------------------------------------------

    const css = [
      '.dsh-pf{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsh-pf *{box-sizing:border-box}',
      '.dsh-pf-top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.dsh-pf-title{font-size:15px;font-weight:600}',
      '.dsh-pf-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.dsh-pf-grow{flex:1;min-width:0}',
      '.dsh-pf-body{flex:1;min-height:0;display:flex}',
      '.dsh-pf-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.dsh-pf-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px}',
      '.dsh-pf-card+.dsh-pf-card{margin-top:12px}',
      '.dsh-pf-h{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin-bottom:10px}',
      '.dsh-pf-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}',
      '.dsh-pf-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dsh-pf-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-pf input,.dsh-pf select,.dsh-pf textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;width:100%;outline:none}',
      '.dsh-pf input:focus,.dsh-pf select:focus,.dsh-pf textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-pf textarea{resize:vertical;line-height:1.55;min-height:64px;font-family:inherit}',
      '.dsh-pf button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;padding:6px 12px;white-space:nowrap}',
      '.dsh-pf button:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.dsh-pf button:disabled{opacity:.45;cursor:not-allowed}',
      '.dsh-pf-primary{background:var(--dsw-alias-brand-primary)!important;border-color:transparent!important;color:#fff!important;font-weight:600}',
      '.dsh-pf-ghost{background:transparent!important}',
      '.dsh-pf-danger{color:var(--dsw-alias-state-error-primary)!important}',
      '.dsh-pf-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.dsh-pf-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.dsh-pf-chip.bad{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.dsh-pf-chip.brand{color:var(--dsw-alias-brand-primary);border-color:currentColor}',
      '.dsh-pf-lang{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;flex:none}',
      '.dsh-pf-lang-btn{appearance:none;-webkit-appearance:none;border:0!important;background:transparent!important;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;padding:5px 9px;cursor:pointer;border-radius:0!important}',
      '.dsh-pf-lang-btn:hover{color:var(--dsw-alias-label-primary)!important;background:var(--dsw-alias-bg-layer-2)!important}',
      '.dsh-pf-lang-btn[data-active="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.dsh-pf-lib{padding:14px;overflow:auto;flex:1;min-height:0}',
      '.dsh-pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:12px}',
      '.dsh-pf-tile{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;text-align:left}',
      '.dsh-pf-tile:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-pf-thumb{aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.dsh-pf-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.dsh-pf-tile-meta{padding:8px 10px;display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-pf-tile-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pf-stage{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:10px;border:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-pf-stage img{max-width:100%;max-height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none}',
      '.dsh-pf-canvas-wrap{position:relative;line-height:0;max-width:100%;max-height:100%}',
      '.dsh-pf-sel{position:absolute;border:1.5px solid var(--dsw-alias-brand-primary);background:rgba(61,109,147,.18);pointer-events:none}',
      '.dsh-pf-marker{position:absolute;border:1.5px dashed var(--dsw-alias-state-warn-primary);background:rgba(0,0,0,.12);font-size:10px;color:#fff;text-shadow:0 0 3px #000;pointer-events:none;overflow:hidden}',
      '.dsh-pf-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.dsh-pf-tools2{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-pf-tool{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:5px 9px;border-radius:8px;border:1px solid transparent;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dsh-pf-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-pf-tool.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-pf-side{width:330px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}',
      '.dsh-pf-side-pad{padding:10px 12px;display:flex;flex-direction:column;gap:10px;min-height:0}',
      '.dsh-pf-tabs{display:flex;gap:4px;padding:8px 10px 0;flex:none}',
      '.dsh-pf-tab{padding:6px 12px;border-radius:8px 8px 0 0;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary);border:1px solid transparent;border-bottom:none}',
      '.dsh-pf-tab.on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-pf-log{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
      '.dsh-pf-msg{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.5}',
      '.dsh-pf-msg.user{align-items:flex-end}',
      '.dsh-pf-bubble{padding:7px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);max-width:100%;word-break:break-word}',
      '.dsh-pf-msg.user .dsh-pf-bubble{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dsh-pf-note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-pf-tree{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}',
      '.dsh-pf-node{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;cursor:pointer;font-size:12px;min-width:0}',
      '.dsh-pf-node:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-pf-node.on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.dsh-pf-node-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pf-node img{width:22px;height:22px;border-radius:4px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-pf-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-pf-toast{position:fixed;right:22px;bottom:22px;z-index:2147483000;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 14px;font-size:12px;max-width:420px;box-shadow:0 8px 26px rgba(0,0,0,.22)}',
      '.dsh-pf-toast.bad{border-color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pf-modal{position:fixed;inset:0;z-index:2147482900;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dsh-pf-sheet{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;max-width:min(920px,96vw);max-height:92vh;overflow:auto;padding:18px}',
      '.dsh-pf-compare{display:flex;gap:10px;align-items:stretch;justify-content:center;flex-wrap:wrap}',
      '.dsh-pf-compare figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-pf-compare img{max-height:62vh;max-width:44vw;object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-pf-compare figcaption{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dsh-pf-slider{position:relative;overflow:hidden;border-radius:8px;background:var(--dsw-alias-bg-layer-2);user-select:none}',
      '.dsh-pf-slider img{display:block;max-height:62vh;max-width:82vw;object-fit:contain}',
      '.dsh-pf-slider .top{position:absolute;inset:0;overflow:hidden}',
      '.dsh-pf-slider .top img{max-height:none;height:100%;width:100%}',
      '.dsh-pf-slider input{position:absolute;left:0;right:0;bottom:6px;width:calc(100% - 20px);margin:0 10px}',
      '.dsh-pf-keys{display:flex;flex-direction:column;gap:8px}',
      '.dsh-pf-key{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}',
      '.dsh-pf-key code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.dsh-pf-key .off code{opacity:.5;text-decoration:line-through}',
      '.dsh-pf-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}',
      '.dsh-pf-list-item{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;min-width:0}',
      '.dsh-pf-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-pf-spin .8s linear infinite;display:inline-block}',
      '@keyframes dsh-pf-spin{to{transform:rotate(360deg)}}',
      '.dsh-pf-icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0!important}',
      '.dsh-pf svg{display:block}',
    ].join('')

    function Style() {
      return h('style', null, css)
    }

    // -----------------------------------------------------------------------
    // icons
    // -----------------------------------------------------------------------

    const ICONS = {
      sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
      image: 'M4 5h16v14H4zM4 15l4.5-4.5L13 15l2.5-2.5L20 17',
      edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
      brush: 'M6 18c0-2 1-3 3-3s2 1 2 3-2 3-3 3-2-1-2-3zM11 14L20 5l-1-1-9 9',
      scissors: 'M6 6l12 12M18 6L9.5 14.5M7 20a2 2 0 100-4 2 2 0 000 4zM17 20a2 2 0 100-4 2 2 0 000 4z',
      layers: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
      text: 'M5 6h14M12 6v12M9 18h6',
      expand: 'M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5',
      wand: 'M5 19l9-9M14 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM18 12l.7 1.3L20 14l-1.3.7L18 16l-.7-1.3L16 14l1.3-.7z',
      trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
      eraser: 'M7 17l-3-3 9-9 6 6-6 6zM9 19h11',
      palette: 'M12 3a9 9 0 100 18h1.5a2 2 0 002-2c0-1.5 1-2 2-2H19a2 2 0 002-2 9 9 0 00-9-9zM7.5 10.5h.01M11 8h.01M15 9.5h.01',
      gallery: 'M4 6h7v7H4zM13 6h7v4h-7zM13 12h7v6h-7zM4 15h7v3H4z',
      plus: 'M12 5v14M5 12h14',
      back: 'M15 6l-6 6 6 6',
      star: 'M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z',
      download: 'M12 4v10M8 11l4 4 4-4M5 19h14',
      compare: 'M12 4v16M6 8H3v8h3zM21 8h-3v8h3z',
      zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5M11 8v6M8 11h6',
      zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5M8 11h6',
      fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
      close: 'M6 6l12 12M18 6L6 18',
      refresh: 'M20 12a8 8 0 11-3-6.2M20 4v5h-5',
      batch: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
      chat: 'M4 5h16v10H9l-5 4z',
      tree: 'M6 4v16M6 8h6v4H6zM12 14h6v4h-6z',
    }

    function Icon({ name, size = 15 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: ICONS[name] ?? ICONS.sparkle }),
      )
    }

    // -----------------------------------------------------------------------
    // small building blocks
    // -----------------------------------------------------------------------

    function Field({ label, hint, children, grow }) {
      return h(
        'label',
        { className: 'dsh-pf-field', style: grow ? { flex: grow } : undefined },
        label ? h('span', { className: 'dsh-pf-label' }, label) : null,
        children,
        hint ? h('span', { className: 'dsh-pf-note' }, hint) : null,
      )
    }

    function Toast({ toast, onDone }) {
      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(onDone, toast.bad ? 7000 : 3200)
        return () => clearTimeout(timer)
      }, [toast, onDone])
      if (!toast) return null
      return h('div', { className: `dsh-pf-toast${toast.bad ? ' bad' : ''}` }, toast.text)
    }

    function useToast() {
      const [toast, setToast] = useState(null)
      const show = useCallback((text, bad = false) => setToast({ text: String(text ?? ''), bad, at: Date.now() }), [])
      const clear = useCallback(() => setToast(null), [])
      return [toast, show, clear]
    }

    function Spinner({ label }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 7 } }, h('span', { className: 'dsh-pf-spin' }), label ?? null)
    }

    function Modal({ children, onClose, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        { className: 'dsh-pf-modal', onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h('div', { className: 'dsh-pf-sheet', style: width ? { width } : undefined }, children),
      )
    }

    function fmtBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function fmtMs(ms) {
      if (!Number.isFinite(ms)) return ''
      return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
    }

    // -----------------------------------------------------------------------
    // canvas with drag selection
    // -----------------------------------------------------------------------

    /**
     * Renders a picture and turns drag gestures into percentage rectangles.
     * Percentages keep the selection meaningful across every size the model
     * might answer with, and let the server reuse the same rectangle for both
     * the vision plan and the pixel paste.
     */
    function Canvas({ src, markers, onSelect, onMarkerClick, alt }) {
      const wrapRef = useRef(null)
      const [drag, setDrag] = useState(null)
      const [box, setBox] = useState(null)

      const relative = useCallback((event) => {
        const rect = wrapRef.current?.getBoundingClientRect()
        if (!rect || rect.width === 0 || rect.height === 0) return null
        const x = ((event.clientX - rect.left) / rect.width) * 100
        const y = ((event.clientY - rect.top) / rect.height) * 100
        return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) }
      }, [])

      const onDown = (event) => {
        if (!onSelect || event.button !== 0) return
        const point = relative(event)
        if (!point) return
        event.preventDefault()
        setDrag(point)
        setBox(null)
        wrapRef.current?.setPointerCapture?.(event.pointerId)
      }

      const onMove = (event) => {
        if (!drag) return
        const point = relative(event)
        if (!point) return
        setBox({
          x: Math.min(drag.x, point.x),
          y: Math.min(drag.y, point.y),
          width: Math.abs(point.x - drag.x),
          height: Math.abs(point.y - drag.y),
        })
      }

      const onUp = (event) => {
        if (!drag) return
        const point = relative(event)
        const finished = box
        setDrag(null)
        setBox(null)
        wrapRef.current?.releasePointerCapture?.(event.pointerId)
        if (!finished || finished.width < 1.5 || finished.height < 1.5) return
        if (point && Math.hypot(point.x - drag.x, point.y - drag.y) < 1.2) return
        onSelect?.({
          x: Number(finished.x.toFixed(2)),
          y: Number(finished.y.toFixed(2)),
          width: Number(finished.width.toFixed(2)),
          height: Number(finished.height.toFixed(2)),
        })
      }

      if (!src) return h('div', { className: 'dsh-pf-empty' }, alt ?? null)

      return h(
        'div',
        {
          ref: wrapRef,
          className: 'dsh-pf-canvas-wrap',
          style: { cursor: onSelect ? 'crosshair' : 'default', touchAction: 'none' },
          onPointerDown: onDown,
          onPointerMove: onMove,
          onPointerUp: onUp,
          onPointerCancel: () => {
            setDrag(null)
            setBox(null)
          },
        },
        h('img', { src, alt: '', draggable: false }),
        (markers ?? []).map((marker, index) =>
          h(
            'div',
            {
              key: marker.id ?? index,
              className: 'dsh-pf-marker',
              style: {
                left: `${marker.rect.x}%`,
                top: `${marker.rect.y}%`,
                width: `${marker.rect.width}%`,
                height: `${marker.rect.height}%`,
                cursor: onMarkerClick ? 'pointer' : 'default',
                pointerEvents: onMarkerClick ? 'auto' : 'none',
              },
              onClick: onMarkerClick ? (event) => { event.stopPropagation(); onMarkerClick(marker) } : undefined,
              title: marker.text ?? '',
            },
            h('span', { style: { padding: '2px 4px', display: 'block' } }, marker.text ?? ''),
          ),
        ),
        box
          ? h('div', {
              className: 'dsh-pf-sel',
              style: { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` },
            })
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // operation panel: the per-operation controls
    // -----------------------------------------------------------------------

    const NEEDS_RECT = new Set(['localEdit', 'removeWatermark', 'extractAsset', 'fusion'])
    const NEEDS_RECTS = new Set(['removeElement'])
    const NEEDS_PROMPT = new Set(['text2image', 'edit', 'localEdit', 'fusion', 'enhance', 'outpaint', 'batchVariables', 'batchList'])

    function OperationPanel({ op, state, setState, onSubmit, busy, sizes }) {
      const t = useT()
      const set = (patch) => setState({ ...state, ...patch })

      const children = []

      if (NEEDS_PROMPT.has(op)) {
        children.push(
          h(Field, { key: 'prompt', label: t('prompt') },
            h('textarea', {
              className: 'dsh-pf-area',
              value: state.prompt ?? '',
              placeholder: t('promptPlaceholder'),
              onChange: (event) => set({ prompt: event.target.value }),
              rows: 3,
            }),
          ),
        )
      }

      if (op === 'batchVariables') {
        children.push(
          h(Field, { key: 'values', label: t('values'), hint: t('variablesHint') },
            h('textarea', { value: state.values ?? '', onChange: (event) => set({ values: event.target.value }), rows: 3 }),
          ),
        )
      }

      if (op === 'batchList') {
        children.push(
          h(Field, { key: 'prompts', label: t('prompts'), hint: t('listHint') },
            h('textarea', { value: state.prompts ?? '', onChange: (event) => set({ prompts: event.target.value }), rows: 4 }),
          ),
          h(Field, { key: 'style', label: t('unifiedStyle') },
            h('input', { value: state.unifiedStyle ?? '', onChange: (event) => set({ unifiedStyle: event.target.value }) }),
          ),
        )
      }

      if (NEEDS_RECT.has(op)) {
        children.push(
          h('div', { key: 'rect', className: 'dsh-pf-row', style: { alignItems: 'center' } },
            h('span', { className: 'dsh-pf-chip' }, `${t('selection')}: ${state.rect ? `${Math.round(state.rect.x)},${Math.round(state.rect.y)} ${Math.round(state.rect.width)}×${Math.round(state.rect.height)}%` : '—'}`),
            state.rect ? h('button', { className: 'dsh-pf-ghost', onClick: () => set({ rect: null }) }, t('clearSelection')) : null,
          ),
        )
      }

      if (NEEDS_RECTS.has(op)) {
        children.push(
          h(Field, { key: 'preset', label: t('preset') },
            h('select', { value: state.preset ?? 'clutter', onChange: (event) => set({ preset: event.target.value }) },
              ['box', 'bystanders', 'clutter', 'text', 'tidy'].map((id) => h('option', { key: id, value: id }, t(`preset_${id}`) ?? id)),
            ),
          ),
          h('div', { key: 'rects', className: 'dsh-pf-row', style: { alignItems: 'center' } },
            h('span', { className: 'dsh-pf-chip' }, `${t('selection')}: ${(state.rects ?? []).length}`),
            h('span', { className: 'dsh-pf-note' }, t('keepHint')),
            (state.rects ?? []).length ? h('button', { className: 'dsh-pf-ghost', onClick: () => set({ rects: [] }) }, t('clearSelection')) : null,
          ),
        )
      }

      if (op === 'extractAsset') {
        children.push(
          h(Field, { key: 'kind', label: t('kind') },
            h('select', { value: state.kind ?? 'box', onChange: (event) => set({ kind: event.target.value }) },
              ['box', 'clothing', 'accessory', 'pattern', 'background'].map((id) => h('option', { key: id, value: id }, t(`kind_${id}`) ?? id)),
            ),
          ),
        )
      }

      if (op === 'fusion') {
        children.push(
          h(Field, { key: 'mode', label: t('mode') },
            h('select', { value: state.mode ?? 'basic', onChange: (event) => set({ mode: event.target.value }) },
              ['basic', 'outfit', 'pose', 'group'].map((id) => h('option', { key: id, value: id }, t(`fusion_${id}`) ?? id)),
            ),
          ),
          h('div', { key: 'ref', className: 'dsh-pf-row', style: { alignItems: 'center' } },
            h('span', { className: state.reference ? 'dsh-pf-chip ok' : 'dsh-pf-chip' }, state.reference ? `${t('reference')}: ${state.reference.name ?? 'ok'}` : t('dropHint')),
            state.reference ? h('button', { className: 'dsh-pf-ghost', onClick: () => set({ reference: null }) }, t('close')) : null,
          ),
        )
      }

      if (op === 'colorize') {
        children.push(
          h(Field, { key: 'mode', label: t('mode') },
            h('select', { value: state.mode ?? 'mono', onChange: (event) => set({ mode: event.target.value }) },
              ['mono', 'lineart', 'toLineart'].map((id) => h('option', { key: id, value: id }, t(`colour_${id}`) ?? id)),
            ),
          ),
          h(Field, { key: 'palette', label: t('palette') },
            h('input', { value: state.palette ?? '', onChange: (event) => set({ palette: event.target.value }), placeholder: 'warm sepia' }),
          ),
        )
      }

      if (op === 'enhance') {
        children.push(
          h(Field, { key: 'strength', label: t('strength') },
            h('select', { value: state.strength ?? 'standard', onChange: (event) => set({ strength: event.target.value }) },
              ['light', 'standard', 'strong'].map((id) => h('option', { key: id, value: id }, id)),
            ),
          ),
        )
      }

      if (op === 'outpaint') {
        children.push(
          h(Field, { key: 'size', label: t('size') },
            h('select', { value: state.size ?? '1536x1024', onChange: (event) => set({ size: event.target.value }) },
              (sizes ?? []).map((size) => h('option', { key: size, value: size }, size)),
            ),
          ),
        )
      }

      if (op === 'text2image' || op === 'batchList' || op === 'batchVariables') {
        children.push(
          h('div', { key: 'size-n', className: 'dsh-pf-row' },
            h(Field, { label: t('size'), grow: 2 },
              h('select', { value: state.size ?? '1024x1024', onChange: (event) => set({ size: event.target.value }) },
                (sizes ?? []).map((size) => h('option', { key: size, value: size }, size)),
              ),
            ),
            h(Field, { label: t('count'), grow: 1 },
              h('select', { value: String(state.n ?? 1), onChange: (event) => set({ n: Number(event.target.value) }) },
                [1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, String(n))),
              ),
            ),
          ),
        )
      }

      return h('div', { className: 'dsh-pf-col', style: { gap: 10 } }, children)
    }

    // -----------------------------------------------------------------------
    // in-image text editor
    // -----------------------------------------------------------------------

    function TextPanel({ regions, setRegions, onRecognise, busy, onApply }) {
      const t = useT()
      if (!regions) {
        return h('div', { className: 'dsh-pf-col', style: { gap: 10 } },
          h('div', { className: 'dsh-pf-note' }, t('regions')),
          h('button', { onClick: onRecognise, disabled: busy }, busy ? h(Spinner) : t('recognise')),
        )
      }
      return h('div', { className: 'dsh-pf-col', style: { gap: 10 } },
        h('div', { className: 'dsh-pf-row' },
          h('span', { className: 'dsh-pf-chip ok' }, `${t('regions')}: ${regions.length}`),
          h('span', { className: 'dsh-pf-grow' }),
          h('button', { className: 'dsh-pf-ghost', onClick: onRecognise, disabled: busy }, h(Icon, { name: 'refresh', size: 12 })),
        ),
        h('div', { className: 'dsh-pf-list', style: { maxHeight: 260 } },
          regions.map((region) =>
            h('div', { key: region.id, className: 'dsh-pf-list-item', style: { flexDirection: 'column', alignItems: 'stretch', gap: 5 } },
              h('div', { className: 'dsh-pf-row', style: { gap: 6 } },
                h('span', { className: 'dsh-pf-chip' }, `#${region.id}`),
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: region.text }, region.text),
                h('button', { className: 'dsh-pf-ghost', onClick: () => setRegions(regions.map((row) => row.id === region.id ? { ...row, drop: !row.drop } : row)) },
                  region.drop ? t('replaceWith') : t('clearText')),
              ),
              region.drop ? null : h('input', {
                value: region.next ?? '',
                placeholder: t('replaceWith'),
                onChange: (event) => setRegions(regions.map((row) => row.id === region.id ? { ...row, next: event.target.value } : row)),
              }),
            ),
          ),
        ),
        h('button', { className: 'dsh-pf-primary', onClick: onApply, disabled: busy }, busy ? t('working') : t('apply')),
      )
    }

    // -----------------------------------------------------------------------
    // compare view
    // -----------------------------------------------------------------------

    function Compare({ beforeId, afterId, onClose }) {
      const t = useT()
      const before = useAssetUrl(beforeId)
      const after = useAssetUrl(afterId)
      const [split, setSplit] = useState(50)
      const [mode, setMode] = useState('side')

      return h(Modal, { onClose, width: 'min(1000px,96vw)' },
        h('div', { className: 'dsh-pf-row', style: { justifyContent: 'space-between', marginBottom: 12 } },
          h('div', { className: 'dsh-pf-h', style: { margin: 0 } }, t('compare')),
          h('div', { className: 'dsh-pf-row' },
            h('button', { className: mode === 'side' ? 'dsh-pf-primary' : '', onClick: () => setMode('side') }, t('before')),
            h('button', { className: mode === 'slider' ? 'dsh-pf-primary' : '', onClick: () => setMode('slider') }, '↔'),
            h('button', { className: 'dsh-pf-ghost', onClick: onClose }, h(Icon, { name: 'close', size: 13 })),
          ),
        ),
        mode === 'side'
          ? h('div', { className: 'dsh-pf-compare' },
              h('figure', null, before ? h('img', { src: before, alt: '' }) : h('div', { className: 'dsh-pf-empty' }, '—'), h('figcaption', null, t('before'))),
              h('figure', null, after ? h('img', { src: after, alt: '' }) : h('div', { className: 'dsh-pf-empty' }, '—'), h('figcaption', null, t('after'))),
            )
          : h('div', { className: 'dsh-pf-slider' },
              after ? h('img', { src: after, alt: '' }) : null,
              h('div', { className: 'top', style: { width: `${split}%` } }, before ? h('img', { src: before, alt: '', style: { width: '100%' } }) : null),
              h('input', { type: 'range', min: 0, max: 100, value: split, onChange: (event) => setSplit(Number(event.target.value)) }),
            ),
      )
    }

    // -----------------------------------------------------------------------
    // workspace
    // -----------------------------------------------------------------------

    const OP_TOOLS = [
      { op: 'localEdit', icon: 'brush' },
      { op: 'removeElement', icon: 'eraser' },
      { op: 'extractAsset', icon: 'scissors' },
      { op: 'removeBackground', icon: 'layers' },
      { op: 'outpaint', icon: 'expand' },
      { op: 'enhance', icon: 'wand' },
      { op: 'removeWatermark', icon: 'trash' },
      { op: 'editText', icon: 'text' },
      { op: 'colorize', icon: 'palette' },
      { op: 'fusion', icon: 'image' },
    ]

    function Workspace() {
      const t = useT()
      const opLabel = useOpLabel()
      const [workspace, setWorkspace] = useState(null)
      const [loading, setLoading] = useState(true)
      const [tab, setTab] = useState('chat')
      const [op, setOp] = useState('text2image')
      const [form, setForm] = useState({ size: '1024x1024', n: 1 })
      const [busy, setBusy] = useState(false)
      const [run, setRun] = useState(null)
      const [zoom, setZoom] = useState(1)
      const [comparing, setComparing] = useState(false)
      const [toast, showToast, clearToast] = useToast()
      const [selectedId, setSelectedId] = useState('')
      const [reference, setReference] = useState(null)
      const [sizes, setSizes] = useState([])
      const [models, setModels] = useState({ image: [], vision: [] })
      const [library, setLibrary] = useState([])
      const [keyCount, setKeyCount] = useState(null)
      const abortRef = useRef(null)
      const refInput = useRef(null)
      const model = useRef({ image: '', vision: '' })

      const rect = form.rect ?? null
      const rects = form.rects ?? []
      const setRect = useCallback((next) => setForm((previous) => ({ ...previous, rect: next })), [])
      const setRects = useCallback((next) => setForm((previous) => ({ ...previous, rects: typeof next === 'function' ? next(previous.rects ?? []) : next })), [])

      const load = useCallback(async () => {
        try {
          const body = await api('workspace')
          const next = body.workspace
          setWorkspace(next)
          const current = next.currentVersionId || next.versions.at(-1)?.id || ''
          setSelectedId((previous) => previous && next.versions.some((v) => v.id === previous) ? previous : current)
          model.current = {
            image: next.models?.image || next.versions.at(-1)?.model || '',
            vision: next.models?.vision || '',
          }
        } catch (error) {
          showToast(error.message, true)
        } finally {
          setLoading(false)
        }
      }, [showToast])

      useEffect(() => {
        load()
        api('models').then((body) => setSizes(body.sizes ?? [])).catch(() => {})
        // The pickers follow the configured lists, not the discovered ones: an
        // upstream catalogue can omit models that still answer requests.
        api('config').then((body) => {
          setModels({
            image: (body.config?.models?.items ?? []).map((row) => row.id),
            vision: (body.config?.models?.visionItems ?? []).map((row) => row.id),
          })
          if (!model.current.image) model.current.image = body.config?.models?.default ?? ''
          if (!model.current.vision) model.current.vision = body.config?.models?.visionDefault ?? ''
          setForm((previous) => ({ ...previous }))
        }).catch(() => {})
        api('library').then((body) => setLibrary(body.prompts ?? [])).catch(() => {})
        api('config').then((body) => setKeyCount(body.resolved?.keyCount ?? null)).catch(() => {})
      }, [load])

      const versions = workspace?.versions ?? []
      const version = useMemo(() => {
        if (versions.length === 0) return null
        return versions.find((row) => row.id === selectedId) ?? versions.at(-1) ?? null
      }, [versions, selectedId])

      const currentImageId = version?.images?.[0] ?? ''
      const currentSrc = useAssetUrl(currentImageId)
      const parentVersion = useMemo(() => {
        if (!version?.parentId) return null
        return versions.find((row) => row.id === version.parentId) ?? null
      }, [versions, version])
      const parentSrc = useAssetUrl(parentVersion?.images?.[0] ?? '')

      const readFile = (file) => new Promise((resolve, reject) => {
        if (!file) return resolve(null)
        const reader = new FileReader()
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) })
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })

      const submit = async () => {
        if (busy) return
        setBusy(true)
        setRun(null)
        const controller = new AbortController()
        abortRef.current = controller
        const payload = {
          op,
          baseVersionId: version?.id ?? '',
          prompt: form.prompt ?? '',
          values: form.values ?? '',
          prompts: form.prompts ?? '',
          unifiedStyle: form.unifiedStyle ?? '',
          preset: form.preset ?? 'clutter',
          kind: form.kind ?? 'box',
          mode: form.mode ?? (op === 'fusion' ? 'basic' : 'mono'),
          strength: form.strength ?? 'standard',
          palette: form.palette ?? '',
          size: form.size ?? '1024x1024',
          n: form.n ?? 1,
          model: model.current.image || undefined,
          visionModel: model.current.vision || undefined,
          image: op === 'text2image' ? undefined : undefined,
          rect: op === 'localEdit' || op === 'removeWatermark' || op === 'extractAsset' || op === 'fusion' ? rect ?? undefined : undefined,
          rects: op === 'removeElement' ? rects : undefined,
          referenceImage: op === 'fusion' ? reference?.dataUrl : undefined,
          regions: op === 'editText' ? (form.regions ?? []).map((row) => ({ id: row.id, text: row.text, rect: row.rect, next: row.next ?? '', drop: row.drop === true })) : undefined,
        }
        try {
          const body = await api('operations', { body: payload, signal: controller.signal })
          setRun(body)
          if (body.workspace) {
            setWorkspace(body.workspace)
            if (body.version?.id) setSelectedId(body.version.id)
          }
          setRects([])
          setRect(null)
        } catch (error) {
          if (error.name !== 'AbortError') showToast(`${error.code ? `[${error.code}] ` : ''}${error.message}`, true)
        } finally {
          setBusy(false)
          abortRef.current = null
        }
      }

      const recognise = async () => {
        setBusy(true)
        try {
          const body = await api('recognise', { body: { versionId: version?.id ?? '', visionModel: model.current.vision || undefined } })
          setForm((previous) => ({ ...previous, regions: (body.regions ?? []).map((row) => ({ ...row, next: '', drop: false })) }))
          showToast(`${t('regions')}: ${(body.regions ?? []).length}`)
        } catch (error) {
          showToast(`${error.code ? `[${error.code}] ` : ''}${error.message}`, true)
          setForm((previous) => ({ ...previous, regions: [] }))
        } finally {
          setBusy(false)
        }
      }

      const addRect = (next) => {
        if (op === 'removeElement') setRects((list) => [...list, next])
        else setRect(next)
      }

      const patchWorkspace = async (patch) => {
        try {
          const body = await api('workspace', { body: { action: 'update', patch } })
          setWorkspace(body.workspace)
        } catch (error) {
          showToast(error.message, true)
        }
      }

      const clearHistory = async () => {
        if (!window.confirm(t('clearHistoryConfirm'))) return
        try {
          const body = await api('workspace', { body: { action: 'reset' } })
          setWorkspace(body.workspace)
          setSelectedId('')
          setRun(null)
          setRect(null)
          setRects([])
        } catch (error) {
          showToast(error.message, true)
        }
      }

      const downloadCurrent = () => {
        if (!currentSrc) return
        const link = document.createElement('a')
        link.href = currentSrc
        link.download = `pixelfly-${version?.id ?? 'image'}.png`
        link.click()
      }

      const saveToLibrary = async () => {
        const text = (form.prompt ?? '').trim()
        if (!text) return
        try {
          await api('library', { body: { action: 'add', text } })
          const refreshed = await api('library')
          setLibrary(refreshed.prompts ?? [])
          showToast(t('saved'))
        } catch (error) {
          showToast(error.message, true)
        }
      }

      if (loading) return h('div', { className: 'dsh-pf dsh-pf-col' }, h(Style), h('div', { className: 'dsh-pf-empty' }, h(Spinner, { label: t('working') })))
      if (!workspace) return h('div', { className: 'dsh-pf dsh-pf-col' }, h(Style), h('div', { className: 'dsh-pf-empty' }, t('empty')))

      const markers = op === 'editText' ? (form.regions ?? []).map((region) => ({ id: region.id, rect: region.rect, text: region.text })) : []

      return h(
        'div',
        { className: 'dsh-pf dsh-pf-col' },
        h(Style),
        h(
          'div',
          { className: 'dsh-pf-top' },
          h('div', { className: 'dsh-pf-grow' },
            h('div', { className: 'dsh-pf-title' }, t('brand')),
            h('div', { className: 'dsh-pf-sub' }, `${versions.length} ${t('versions')}`),
          ),
          h(LangSwitch, null),
          h('button', { className: 'dsh-pf-ghost', title: t('clearHistory'), onClick: clearHistory }, h(Icon, { name: 'trash', size: 14 })),
        ),
        h(
          'div',
          { className: 'dsh-pf-body' },
          h(
            'div',
            { className: 'dsh-pf-col dsh-pf-grow', style: { padding: 12, gap: 0 } },
            h(
              'div',
              { className: 'dsh-pf-toolbar' },
              h('button', { className: 'dsh-pf-icon-btn dsh-pf-ghost', title: t('zoomOut'), onClick: () => setZoom((z) => Math.max(0.25, z - 0.25)) }, h(Icon, { name: 'zoomOut', size: 14 })),
              h('span', { className: 'dsh-pf-note', style: { minWidth: 40, textAlign: 'center' } }, `${Math.round(zoom * 100)}%`),
              h('button', { className: 'dsh-pf-icon-btn dsh-pf-ghost', title: t('zoomIn'), onClick: () => setZoom((z) => Math.min(4, z + 0.25)) }, h(Icon, { name: 'zoomIn', size: 14 })),
              h('button', { className: 'dsh-pf-icon-btn dsh-pf-ghost', title: t('fit'), onClick: () => setZoom(1) }, h(Icon, { name: 'fit', size: 14 })),
              h('span', { style: { width: 1, height: 18, background: 'var(--dsw-alias-border-l1)' } }),
              h('button', { className: 'dsh-pf-ghost', disabled: !parentVersion, onClick: () => setComparing(true) }, h(Icon, { name: 'compare', size: 14 }), ' ', t('compare')),
              h('button', { className: 'dsh-pf-ghost', disabled: !currentSrc, onClick: downloadCurrent }, h(Icon, { name: 'download', size: 14 }), ' ', t('download')),
              h('span', { className: 'dsh-pf-grow' }),
              version ? h('span', { className: 'dsh-pf-chip' }, `${opLabel(version.op)} · ${version.createdAt ? new Date(version.createdAt).toLocaleTimeString() : ''}`) : null,
              keyCount === null ? null : h('span', { className: 'dsh-pf-chip brand' }, `${t('keyCount')}: ${keyCount}`),
            ),
            h(
              'div',
              { className: 'dsh-pf-tools2' },
              OP_TOOLS.map((tool) =>
                h('button', {
                  key: tool.op,
                  className: `dsh-pf-tool${op === tool.op ? ' on' : ''}`,
                  onClick: () => { setOp(tool.op); setRect(null); setRects([]) },
                  title: opLabel(tool.op),
                }, h(Icon, { name: tool.icon, size: 14 }), opLabel(tool.op)),
              ),
            ),
            h(
              'div',
              { className: 'dsh-pf-stage', style: { marginTop: 12 } },
              currentSrc
                ? h('div', { style: { transform: `scale(${zoom})`, transition: 'transform .12s ease', display: 'flex', maxWidth: '100%', maxHeight: '100%' } },
                    h(Canvas, {
                      src: currentSrc,
                      markers,
                      onSelect: NEEDS_RECT.has(op) || NEEDS_RECTS.has(op) ? addRect : undefined,
                      onMarkerClick: op === 'editText' ? (marker) => {
                        setForm((previous) => {
                          const regions = (previous.regions ?? []).map((region) => region.id === marker.id ? { ...region, selected: !region.selected } : region)
                          return { ...previous, regions }
                        })
                      } : undefined,
                      alt: t('noVersions'),
                    }),
                  )
                : h('div', { className: 'dsh-pf-empty' }, t('noVersions')),
              busy ? h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#fff', fontSize: 13 } },
                h(Spinner, { label: t('working') }),
                h('button', { onClick: () => abortRef.current?.abort() }, t('cancelRun')),
              ) : null,
            ),
            run
              ? h('div', { className: 'dsh-pf-row', style: { marginTop: 10, alignItems: 'center' } },
                  h('span', { className: 'dsh-pf-chip ok' }, `${t('result')}: ${run.images?.length ?? 0}`),
                  h('span', { className: 'dsh-pf-chip' }, `${t('attempts')}: ${run.meta?.attempts ?? run.meta?.trace?.length ?? 1}`),
                  run.meta?.keyId ? h('span', { className: 'dsh-pf-chip' }, `${t('keyUsed')}: ${run.meta.keyId}`) : null,
                  run.images?.length ? h('button', { className: 'dsh-pf-ghost', onClick: () => setSelectedId(run.version?.id ?? selectedId) }, t('open')) : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'dsh-pf-side' },
            h(
              'div',
              { className: 'dsh-pf-tabs' },
              [['chat', 'chat'], ['batch', 'batch'], ['versions', 'tree']].map(([id, icon]) =>
                h('div', { key: id, className: `dsh-pf-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) },
                  h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h(Icon, { name: icon, size: 13 }), t(id)),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsh-pf-side-pad', style: { flex: 1, minHeight: 0, overflow: 'auto' } },
              tab === 'versions'
                ? h('div', { className: 'dsh-pf-tree' },
                    [...versions].reverse().map((row) =>
                      h('div', { key: row.id, className: `dsh-pf-node${row.id === version?.id ? ' on' : ''}`, onClick: () => setSelectedId(row.id) },
                        h('span', { className: 'dsh-pf-node-label', title: row.prompt || row.label }, `${opLabel(row.op)} · ${row.prompt ? row.prompt.slice(0, 26) : row.label ?? ''}`),
                        h('span', { className: 'dsh-pf-note' }, row.images?.length ? `${row.images.length}` : ''),
                      ),
                    ),
                  )
                : null,
              tab === 'chat'
                ? h('div', { className: 'dsh-pf-col', style: { gap: 10 } },
                    h('div', { className: 'dsh-pf-row' },
                      h('select', { value: op, onChange: (event) => { setOp(event.target.value); setRect(null); setRects([]) }, style: { maxWidth: 150 } },
                        ['text2image', 'edit', 'localEdit', 'fusion', 'batchVariables', 'batchList', 'outpaint', 'enhance', 'removeWatermark', 'removeBackground', 'removeElement', 'extractAsset', 'editText', 'colorize']
                          .map((id) => h('option', { key: id, value: id }, opLabel(id))),
                      ),
                      h('span', { className: 'dsh-pf-grow' }),
                      h('button', { className: 'dsh-pf-ghost', onClick: saveToLibrary, disabled: !(form.prompt ?? '').trim() }, h(Icon, { name: 'star', size: 12 })),
                    ),
                    op === 'editText'
                      ? h(TextPanel, {
                          regions: form.regions ?? null,
                          setRegions: (regions) => setForm((previous) => ({ ...previous, regions })),
                          busy,
                          onRecognise: recognise,
                          onApply: submit,
                        })
                      : h(OperationPanel, { op, state: form, setState: setForm, onSubmit: submit, busy, sizes }),
                    h('div', { className: 'dsh-pf-row' },
                      h(Field, { label: t('model'), grow: 1 },
                        h('select', { value: model.current.image, onChange: (event) => { model.current.image = event.target.value; setForm((previous) => ({ ...previous })) } },
                          models.image.map((id) => h('option', { key: id, value: id }, id)),
                        ),
                      ),
                      h(Field, { label: t('visionModel'), grow: 1 },
                        h('select', { value: model.current.vision, onChange: (event) => { model.current.vision = event.target.value; setForm((previous) => ({ ...previous })) } },
                          [''].concat(models.vision).map((id) => h('option', { key: id || 'none', value: id }, id || '—')),
                        ),
                      ),
                    ),
                    op === 'fusion' || op === 'colorize'
                      ? h('div', { className: 'dsh-pf-row' },
                          h('button', { className: 'dsh-pf-ghost', onClick: () => refInput.current?.click() }, h(Icon, { name: 'image', size: 13 }), ' ', reference ? reference.name : t('pickReference')),
                          h('input', { ref: refInput, type: 'file', accept: 'image/*', style: { display: 'none' },
                            onChange: async (event) => { const file = await readFile(event.target.files?.[0]); if (file) setReference(file); event.target.value = '' } }),
                        )
                      : null,
                    h('button', { className: 'dsh-pf-primary', onClick: submit, disabled: busy }, busy ? t('working') : t('send')),
                    library.length
                      ? h('div', null,
                          h('div', { className: 'dsh-pf-h', style: { marginTop: 4 } }, t('libraryPrompts')),
                          h('div', { className: 'dsh-pf-list' },
                            library.slice(0, 12).map((entry) =>
                              h('div', { key: entry.id, className: 'dsh-pf-list-item' },
                                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.text }, entry.text),
                                h('button', { className: 'dsh-pf-ghost', onClick: () => setForm((previous) => ({ ...previous, prompt: entry.text })) }, t('usePrompt')),
                              ),
                            ),
                          ),
                        )
                      : null,
                  )
                : null,
              tab === 'batch'
                ? h('div', { className: 'dsh-pf-col', style: { gap: 10 } },
                    h(Field, { label: t('prompt'), hint: t('variablesHint') },
                      h('textarea', { value: form.prompt ?? '', onChange: (event) => setForm({ ...form, prompt: event.target.value }), rows: 3 }),
                    ),
                    h(Field, { label: t('values') },
                      h('textarea', { value: form.values ?? '', onChange: (event) => setForm({ ...form, values: event.target.value }), rows: 3 }),
                    ),
                    h(Field, { label: t('prompts'), hint: t('listHint') },
                      h('textarea', { value: form.prompts ?? '', onChange: (event) => setForm({ ...form, prompts: event.target.value }), rows: 4 }),
                    ),
                    h(Field, { label: t('unifiedStyle') },
                      h('input', { value: form.unifiedStyle ?? '', onChange: (event) => setForm({ ...form, unifiedStyle: event.target.value }) }),
                    ),
                    h('div', { className: 'dsh-pf-row' },
                      h('button', { className: 'dsh-pf-primary', onClick: () => { setOp('batchVariables'); submit() }, disabled: busy }, `${opLabel('batchVariables')} (${(form.values ?? '').split('\n').filter((line) => line.trim()).length})`),
                      h('button', { onClick: () => { setOp('batchList'); submit() }, disabled: busy }, `${opLabel('batchList')} (${(form.prompts ?? '').split('\n').filter((line) => line.trim()).length})`),
                    ),
                  )
                : null,
            ),
          ),
        ),
        comparing && parentVersion ? h(Compare, { beforeId: parentVersion.images?.[0] ?? '', afterId: currentImageId, onClose: () => setComparing(false) }) : null,
        h(Toast, { toast, onDone: clearToast }),
      )
    }

    // -----------------------------------------------------------------------
    // settings section
    // -----------------------------------------------------------------------

    function KeyRow({ entry, onToggle, onRemove, onTest, busyId }) {
      const t = useT()
      const [result, setResult] = useState(null)
      const busy = busyId === entry.id
      return h(
        'div',
        { className: `dsh-pf-key${entry.enabled ? '' : ' off'}` },
        h('code', null, entry.masked || '—'),
        entry.label ? h('span', { className: 'dsh-pf-note' }, entry.label) : null,
        h('span', { className: 'dsh-pf-grow' }),
        result
          ? h('span', { className: `dsh-pf-chip ${result.ok ? 'ok' : 'bad'}` },
              result.ok ? `${t('testOk')} · ${fmtMs(result.ms)}` : `${t('testFail')} · ${result.status ?? ''}`)
          : null,
        h('button', { className: 'dsh-pf-ghost', disabled: busy, onClick: async () => {
          setResult(null)
          const value = await onTest(entry.id)
          setResult(value)
        } }, busy ? h(Spinner) : t('test')),
        h('button', { className: 'dsh-pf-ghost', onClick: () => onToggle(entry) }, entry.enabled ? t('disable') : t('enable')),
        h('button', { className: 'dsh-pf-ghost dsh-pf-danger', onClick: () => onRemove(entry) }, h(Icon, { name: 'trash', size: 13 })),
      )
    }

    function SettingsSection() {
      const t = useT()
      const [config, setConfig] = useState(null)
      const [resolved, setResolved] = useState(null)
      const [busy, setBusy] = useState(false)
      const [busyId, setBusyId] = useState('')
      const [draft, setDraft] = useState(null)
      const [single, setSingle] = useState({ key: '', label: '' })
      const [bulk, setBulk] = useState('')
      const [bulkOpen, setBulkOpen] = useState(false)
      const [discovered, setDiscovered] = useState(null)
      const [toast, showToast, clearToast] = useToast()

      const load = useCallback(async () => {
        try {
          const body = await api('config')
          setConfig(body.config)
          setResolved(body.resolved ?? null)
          setDraft(body.config)
        } catch (error) {
          showToast(error.message, true)
        }
      }, [showToast])

      useEffect(() => { load() }, [load])

      const save = async () => {
        if (!draft) return
        setBusy(true)
        try {
          const body = await api('config', { body: {
            upstream: draft.upstream,
            retry: draft.retry,
            request: draft.request,
            models: { default: draft.models?.default, visionDefault: draft.models?.visionDefault },
            limits: draft.limits,
          } })
          setConfig(body.config)
          setDraft(body.config)
          setResolved(body.resolved ?? null)
          showToast(t('saved'))
        } catch (error) {
          showToast(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      const mutateKeys = async (body, message) => {
        try {
          const response = await api('keys', { body })
          setConfig(response.config)
          setDraft(response.config)
          setResolved(response.resolved ?? null)
          if (message) showToast(message)
        } catch (error) {
          showToast(error.message, true)
        }
      }

      const testOne = async (id) => {
        setBusyId(id)
        try {
          const body = await api('test', { body: { id } })
          const row = (body.results ?? [])[0] ?? { ok: false }
          return row
        } catch (error) {
          return { ok: false, status: error.status ?? 0, message: error.message }
        } finally {
          setBusyId('')
        }
      }

      const discover = async () => {
        setBusy(true)
        try {
          const body = await api('models')
          setDiscovered(body.models ?? [])
          showToast(`${t('discovered')}: ${(body.models ?? []).length}`)
        } catch (error) {
          showToast(error.message, true)
        } finally {
          setBusy(false)
        }
      }

      if (!config || !draft) return h('div', { className: 'dsh-pf' }, h(Style), h('div', { className: 'dsh-pf-empty' }, h(Spinner, { label: t('working') })))

      const patch = (path, value) => {
        setDraft((previous) => {
          const next = { ...previous }
          let cursor = next
          for (let index = 0; index < path.length - 1; index += 1) {
            cursor[path[index]] = { ...cursor[path[index]] }
            cursor = cursor[path[index]]
          }
          cursor[path[path.length - 1]] = value
          return next
        })
      }

      return h(
        'div',
        { className: 'dsh-pf', style: { padding: 4 } },
        h(Style),
        h('div', { className: 'dsh-pf-row', style: { justifyContent: 'flex-end', marginBottom: 8 } }, h(LangSwitch, null)),
        h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-h' }, t('upstream')),
          h('div', { className: 'dsh-pf-row' },
            h(Field, { label: t('baseUrl'), grow: 3 },
              h('input', { value: draft.upstream?.baseUrl ?? '', onChange: (event) => patch(['upstream', 'baseUrl'], event.target.value) }),
            ),
            h(Field, { label: t('provider'), grow: 1 },
              h('select', { value: draft.upstream?.provider ?? 'sensenova', onChange: (event) => patch(['upstream', 'provider'], event.target.value) },
                ['sensenova', 'openai', 'gemini'].map((id) => h('option', { key: id, value: id }, id)),
              ),
            ),
          ),
          h('div', { className: 'dsh-pf-row', style: { marginTop: 8 } },
            h(Field, { label: t('timeout'), grow: 1 },
              h('input', { type: 'number', value: draft.upstream?.timeoutMs ?? 180000, onChange: (event) => patch(['upstream', 'timeoutMs'], Number(event.target.value)) }),
            ),
            h(Field, { label: t('visionTimeout'), grow: 1 },
              h('input', { type: 'number', value: draft.upstream?.visionTimeoutMs ?? 90000, onChange: (event) => patch(['upstream', 'visionTimeoutMs'], Number(event.target.value)) }),
            ),
            h('button', { onClick: discover, disabled: busy }, busy ? h(Spinner) : t('discover')),
          ),
        ),
        h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-h' }, t('modelsTitle')),
          h('div', { className: 'dsh-pf-row' },
            h(Field, { label: t('defaultImageModel'), grow: 1 },
              h('select', { value: draft.models?.default ?? '', onChange: (event) => patch(['models', 'default'], event.target.value) },
                (draft.models?.items ?? []).map((row) => h('option', { key: row.id, value: row.id }, row.label ?? row.id)),
              ),
            ),
            h(Field, { label: t('defaultVisionModel'), grow: 1 },
              h('select', { value: draft.models?.visionDefault ?? '', onChange: (event) => patch(['models', 'visionDefault'], event.target.value) },
                (draft.models?.visionItems ?? []).map((row) => h('option', { key: row.id, value: row.id }, row.label ?? row.id)),
              ),
            ),
          ),
          discovered
            ? h('div', { className: 'dsh-pf-list', style: { marginTop: 10 } },
                discovered.map((row) => {
                  const image = (row.outputModalities ?? []).includes('image')
                  const vision = (row.inputModalities ?? []).includes('image')
                  return h('div', { key: row.id, className: 'dsh-pf-list-item' },
                    h('span', { style: { flex: 1 } }, row.id),
                    image ? h('span', { className: 'dsh-pf-chip ok' }, t('imageCapable')) : null,
                    vision ? h('span', { className: 'dsh-pf-chip brand' }, t('visionCapable')) : null,
                    !image && !vision ? h('span', { className: 'dsh-pf-chip' }, t('textOnly')) : null,
                  )
                }),
              )
            : null,
        ),
        h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-h' }, `${t('keysTitle')} · ${(config.apiKeys ?? []).filter((row) => row.enabled).length}/${(config.apiKeys ?? []).length}`),
          h('div', { className: 'dsh-pf-note', style: { marginBottom: 10 } }, t('keysHint')),
          h('div', { className: 'dsh-pf-keys' },
            (config.apiKeys ?? []).map((entry) =>
              h(KeyRow, {
                key: entry.id,
                entry,
                busyId,
                onTest: testOne,
                onToggle: (row) => mutateKeys({ action: 'toggle', id: row.id, enabled: !row.enabled }),
                onRemove: (row) => mutateKeys({ action: 'remove', id: row.id }),
              }),
            ),
          ),
          h('div', { className: 'dsh-pf-row', style: { marginTop: 10 } },
            h(Field, { label: t('label'), grow: 1 },
              h('input', { value: single.label, onChange: (event) => setSingle({ ...single, label: event.target.value }), placeholder: t('label') }),
            ),
            h(Field, { label: 'API Key', grow: 3 },
              h('input', { value: single.key, onChange: (event) => setSingle({ ...single, key: event.target.value }), placeholder: 'sk-…' }),
            ),
            h('button', { className: 'dsh-pf-primary', disabled: !single.key.trim(), onClick: () => {
              mutateKeys({ action: 'add', key: single.key.trim(), label: single.label.trim() }, t('saved'))
              setSingle({ key: '', label: '' })
            } }, t('addKey')),
            h('button', { onClick: () => setBulkOpen(!bulkOpen) }, t('addMany')),
          ),
          bulkOpen
            ? h('div', { style: { marginTop: 10 } },
                h(Field, { label: t('bulkHint') },
                  h('textarea', { value: bulk, onChange: (event) => setBulk(event.target.value), rows: 4 }),
                ),
                h('div', { className: 'dsh-pf-row', style: { marginTop: 8 } },
                  h('button', { className: 'dsh-pf-primary', disabled: !bulk.trim(), onClick: () => {
                    const keys = bulk.split(/[\n,]/).map((line) => line.trim()).filter(Boolean)
                    mutateKeys({ action: 'addMany', keys }, `${t('saved')}: ${keys.length}`)
                    setBulk('')
                    setBulkOpen(false)
                  } }, t('addKey')),
                  h('button', { className: 'dsh-pf-danger', onClick: () => mutateKeys({ action: 'clear' }) }, t('clearKeys')),
                ),
              )
            : null,
        ),
        h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-h' }, t('retryTitle')),
          h('div', { className: 'dsh-pf-row' },
            h(Field, { label: t('maxAttempts'), grow: 1 },
              h('input', { type: 'number', min: 1, max: 12, value: draft.retry?.maxAttempts ?? 4, onChange: (event) => patch(['retry', 'maxAttempts'], Number(event.target.value)) }),
            ),
            h(Field, { label: t('baseDelay'), grow: 1 },
              h('input', { type: 'number', value: draft.retry?.baseDelayMs ?? 700, onChange: (event) => patch(['retry', 'baseDelayMs'], Number(event.target.value)) }),
            ),
            h(Field, { label: t('maxDelay'), grow: 1 },
              h('input', { type: 'number', value: draft.retry?.maxDelayMs ?? 20000, onChange: (event) => patch(['retry', 'maxDelayMs'], Number(event.target.value)) }),
            ),
            h(Field, { label: t('cooldown'), grow: 1 },
              h('input', { type: 'number', value: draft.retry?.cooldownMs ?? 60000, onChange: (event) => patch(['retry', 'cooldownMs'], Number(event.target.value)) }),
            ),
          ),
          h('div', { className: 'dsh-pf-row', style: { marginTop: 10 } },
            h('label', { className: 'dsh-pf-row', style: { gap: 6, alignItems: 'center' } },
              h('input', { type: 'checkbox', style: { width: 'auto' }, checked: draft.retry?.rotateKeys !== false, onChange: (event) => patch(['retry', 'rotateKeys'], event.target.checked) }),
              t('rotate'),
            ),
            h('label', { className: 'dsh-pf-row', style: { gap: 6, alignItems: 'center' } },
              h('input', { type: 'checkbox', style: { width: 'auto' }, checked: draft.retry?.respectRetryAfter !== false, onChange: (event) => patch(['retry', 'respectRetryAfter'], event.target.checked) }),
              t('respectAfter'),
            ),
          ),
        ),
        h('div', { className: 'dsh-pf-card' },
          h('div', { className: 'dsh-pf-h' }, t('limitsTitle')),
          h('div', { className: 'dsh-pf-row' },
            h(Field, { label: t('maxBatch'), grow: 1 },
              h('input', { type: 'number', value: draft.limits?.maxBatch ?? 50, onChange: (event) => patch(['limits', 'maxBatch'], Number(event.target.value)) }),
            ),
            h(Field, { label: t('visionMaxSide'), grow: 1 },
              h('input', { type: 'number', value: draft.limits?.visionMaxSide ?? 768, onChange: (event) => patch(['limits', 'visionMaxSide'], Number(event.target.value)) }),
            ),
          ),
          resolved ? h('div', { className: 'dsh-pf-note', style: { marginTop: 8 } },
            `${t('keyCount')}: ${resolved.keyCount ?? 0}`) : null,
        ),
        h('div', { className: 'dsh-pf-row', style: { marginTop: 12, justifyContent: 'flex-end' } },
          h('button', { onClick: load }, t('cancel')),
          h('button', { className: 'dsh-pf-primary', onClick: save, disabled: busy }, busy ? h(Spinner) : t('save')),
        ),
        h(Toast, { toast, onDone: clearToast }),
      )
    }

    // -----------------------------------------------------------------------
    // root page + registration
    // -----------------------------------------------------------------------

    function StudioPage() {
      return h(Workspace, null)
    }

    function StudioIcon({ size = 18, active }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: ICONS.sparkle }),
        h('circle', { cx: 6.5, cy: 17.5, r: 2.2 }),
      )
    }

    function SidebarLabel() {
      const t = useT()
      return t('brand')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots

        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'pixelfly', order: 42, label: () => (lang === 'zh' ? 'PixelFly' : 'PixelFly') },
            SettingsSection,
          ),
        )

        slots.inject('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 56, label: () => (lang === 'zh' ? 'PixelFly' : 'PixelFly') }, StudioIcon),
        )

        slots.inject('main', () =>
          slots.register({ name: 'main', key: PANEL_ID }, StudioPage),
        )
      },
    }
  },
})
