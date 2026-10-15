/* eslint-disable */
/**
 * Chromium compatibility layer.
 *
 * Sidebery is written against Firefox's `browser.*` WebExtension API. This module
 * builds a `browser` global on top of Chromium's `chrome.*` (Manifest V3) API that
 * emulates the subset of Firefox behaviour Sidebery relies on, and stubs out the
 * Firefox-only APIs (containers, tab hiding, sidebar action, themes, ...).
 *
 * It must be evaluated before any other Sidebery code: it is loaded as the first
 * module script of every page and imported first by the background service worker.
 */

declare const chrome: any
declare const ServiceWorkerGlobalScope: any

type Fn = (...args: any[]) => any

const g = globalThis as any
const IS_SW =
  typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope

g.SIDEBERY_CHROMIUM = true

// ---------------------------------------------------------------------------
// Service worker environment: background script expects a DOM window
// ---------------------------------------------------------------------------
if (IS_SW) {
  g.window = globalThis
  g.devicePixelRatio = g.devicePixelRatio ?? 1

  // Keep last errors for debugging (inspect `__sdbErrors` in the worker console)
  const errors: string[] = (g.__sdbErrors = [])
  const pushErr = (msg: string) => {
    errors.push(msg)
    if (errors.length > 100) errors.shift()
  }
  self.addEventListener('error', (e: any) => {
    pushErr(`error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`)
  })
  self.addEventListener('unhandledrejection', (e: any) => {
    pushErr(`unhandledrejection: ${e.reason?.stack ?? e.reason}`)
  })
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: any[]) => {
      pushErr(`${level}: ${args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ')}`)
      orig(...args)
    }
  }

  const mem = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: any) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }

  // Minimal document stub: there is no DOM in the service worker
  g.document = {
    hidden: true,
    visibilityState: 'hidden',
    body: null,
    documentElement: null,
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    hasFocus: () => false,
  }
  g.getComputedStyle = () => ({ getPropertyValue: () => '' })

  g.matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })

  // Keep the service worker alive: calling an extension API resets the idle timer.
  setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000)

  // Top-level listeners so that the browser starts the worker on startup.
  chrome.runtime.onStartup.addListener(() => {})
  chrome.runtime.onInstalled.addListener(() => {})

  // Open the side panel by clicking the toolbar button
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pick(obj: any, keys: string[]): any {
  if (!obj) return obj
  const out: any = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

function ignoreLastError() {
  void chrome.runtime.lastError
}

interface WrappedEvent {
  addListener: (fn: Fn, ...extra: any[]) => void
  removeListener: (fn: Fn) => void
  hasListener: (fn: Fn) => boolean
  hasListeners?: () => boolean
}

/**
 * Wraps chrome event, optionally transforming listener arguments and
 * dropping Firefox-only listener filters.
 */
function wrapEvent(
  getEvent: () => any,
  mapArgs?: (args: any[], extra: any[]) => any[] | undefined
): WrappedEvent {
  const wrappers = new Map<Fn, Fn>()
  return {
    addListener(fn: Fn, ...extra: any[]) {
      const ev = getEvent()
      if (!ev || wrappers.has(fn)) return
      const wrapper = mapArgs
        ? (...args: any[]) => {
            const mapped = mapArgs(args, extra)
            if (mapped) return fn(...mapped)
          }
        : fn
      wrappers.set(fn, wrapper)
      ev.addListener(wrapper)
    },
    removeListener(fn: Fn) {
      const wrapper = wrappers.get(fn)
      if (!wrapper) return
      wrappers.delete(fn)
      getEvent()?.removeListener(wrapper)
    },
    hasListener(fn: Fn) {
      return wrappers.has(fn)
    },
    hasListeners() {
      return wrappers.size > 0
    },
  }
}

/** Event that never fires */
function dummyEvent(): WrappedEvent {
  return wrapEvent(() => undefined)
}

/** Simple event emitter for emulated events */
function emitter() {
  const listeners = new Set<Fn>()
  return {
    event: {
      addListener: (fn: Fn) => void listeners.add(fn),
      removeListener: (fn: Fn) => void listeners.delete(fn),
      hasListener: (fn: Fn) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
    },
    emit(...args: any[]) {
      for (const fn of listeners) {
        try {
          fn(...args)
        } catch (err) {
          console.error(err)
        }
      }
    },
  }
}

/**
 * Creates namespace object that inherits everything from `chrome[name]` and
 * overrides some of its members. Returns undefined if chrome API is unavailable
 * (e.g. optional permission is not granted).
 */
function namespace(getBase: () => any, overrides: (base: any) => Record<string, any>) {
  let cachedBase: any
  let cached: any
  return () => {
    const base = getBase()
    if (!base) return undefined
    if (base !== cachedBase) {
      cachedBase = base
      cached = Object.create(base)
      const props = overrides(base)
      for (const key of Object.keys(props)) {
        Object.defineProperty(cached, key, {
          value: props[key],
          writable: true,
          configurable: true,
          enumerable: true,
        })
      }
    }
    return cached
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
const NEWTAB_URLS = new Set(['chrome://newtab/', 'chrome://new-tab-page/', 'chrome://newtab'])

/** Firefox url -> chromium url */
function urlIn(url?: string): string | undefined {
  if (!url) return url
  if (url === 'about:newtab' || url === 'about:home' || url === 'about:privatebrowsing') {
    return undefined
  }
  if (url === 'about:settings' || url === 'about:preferences') return 'chrome://settings/'
  if (url === 'about:addons') return 'chrome://extensions/'
  if (url === 'about:downloads') return 'chrome://downloads/'
  if (url === 'about:history') return 'chrome://history/'
  return url
}

/** Chromium url -> Firefox url */
function urlOut(url?: string): string | undefined {
  if (!url) return url
  if (NEWTAB_URLS.has(url)) return 'about:newtab'
  return url
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function fxTab(tab: any): any {
  if (!tab || typeof tab !== 'object') return tab
  if (!tab.url) tab.url = tab.pendingUrl || 'about:blank'
  tab.url = urlOut(tab.url)
  if (tab.pendingUrl) tab.pendingUrl = urlOut(tab.pendingUrl)
  if (tab.hidden === undefined) tab.hidden = false
  if (tab.cookieStoreId === undefined) {
    tab.cookieStoreId = tab.incognito ? 'firefox-private' : 'firefox-default'
  }
  if (tab.isArticle === undefined) tab.isArticle = false
  if (tab.isInReaderMode === undefined) tab.isInReaderMode = false
  if (tab.lastAccessed === undefined) tab.lastAccessed = Date.now()
  if (tab.title === undefined) tab.title = tab.url
  return tab
}

function fxTabs(tabs: any): any {
  if (Array.isArray(tabs)) tabs.forEach(fxTab)
  return tabs
}

const TAB_CREATE_KEYS = ['active', 'index', 'openerTabId', 'pinned', 'url', 'windowId']
const TAB_UPDATE_KEYS = ['active', 'autoDiscardable', 'highlighted', 'muted', 'openerTabId', 'pinned', 'url']
const TAB_QUERY_KEYS = [
  'active',
  'audible',
  'autoDiscardable',
  'currentWindow',
  'discarded',
  'frozen',
  'groupId',
  'highlighted',
  'index',
  'lastFocusedWindow',
  'muted',
  'pinned',
  'status',
  'title',
  'url',
  'windowId',
  'windowType',
]

/** Track active tabs to emulate `previousTabId` of tabs.onActivated */
const activeTabs = new Map<number, number>()
const onActivated = emitter()
let activeTabsInitialized = false
function initActiveTabsTracking() {
  if (activeTabsInitialized || !chrome.tabs) return
  activeTabsInitialized = true
  chrome.tabs.query({ active: true }).then((tabs: any[]) => {
    for (const t of tabs) if (!activeTabs.has(t.windowId)) activeTabs.set(t.windowId, t.id)
  })
  chrome.tabs.onActivated.addListener((info: any) => {
    const prev = activeTabs.get(info.windowId)
    activeTabs.set(info.windowId, info.tabId)
    const fxInfo: any = { tabId: info.tabId, windowId: info.windowId }
    if (prev !== undefined && prev !== info.tabId) fxInfo.previousTabId = prev
    onActivated.emit(fxInfo)
  })
  chrome.tabs.onRemoved.addListener((tabId: number, info: any) => {
    if (activeTabs.get(info.windowId) === tabId) activeTabs.delete(info.windowId)
  })
  chrome.tabs.onDetached.addListener((tabId: number, info: any) => {
    if (activeTabs.get(info.oldWindowId) === tabId) activeTabs.delete(info.oldWindowId)
  })
}
initActiveTabsTracking()

function resolveExtUrl(file: string): string {
  try {
    const base = g.location?.href ?? chrome.runtime.getURL('/bg/background.js')
    return new URL(file, base).pathname
  } catch {
    return file
  }
}

const INIT_DATA_CODE_RE = /^window\.sideberyInitData=(.*);window\.onSideberyInitDataReady\?\.\(\);true;$/s
const FORCE_DISCARD_CODE_RE = /^window\.onbeforeunload=null;/

async function executeScript(tabId: any, details?: any): Promise<any[]> {
  if (typeof tabId === 'object' && tabId !== null) {
    details = tabId
    tabId = undefined
  }
  if (tabId === undefined || tabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = tab?.id
  }
  details = details ?? {}

  const target: any = { tabId }
  if (details.frameId !== undefined) target.frameIds = [details.frameId]
  else if (details.allFrames) target.allFrames = true

  const inj: any = { target }
  if (details.runAt === 'document_start') inj.injectImmediately = true

  if (details.file) {
    inj.files = [resolveExtUrl(details.file)]
  } else if (typeof details.code === 'string') {
    const initDataMatch = INIT_DATA_CODE_RE.exec(details.code)
    if (initDataMatch) {
      inj.func = (data: any) => {
        ;(window as any).sideberyInitData = data
        ;(window as any).onSideberyInitDataReady?.()
        return true
      }
      inj.args = [JSON.parse(initDataMatch[1])]
    } else if (FORCE_DISCARD_CODE_RE.test(details.code)) {
      inj.world = 'MAIN'
      inj.func = () => {
        window.onbeforeunload = null
        window.addEventListener('beforeunload', e => {
          e.returnValue = ''
        })
      }
    } else {
      throw new Error('Arbitrary code injection is not supported in Chromium')
    }
  } else {
    throw new Error('No script to inject')
  }

  const results = await chrome.scripting.executeScript(inj)
  return (results ?? []).map((r: any) => r?.result)
}

async function captureTab(tabId?: number, opts?: any): Promise<string> {
  let tab: any
  if (tabId === undefined || tabId === null) {
    ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } else {
    tab = await chrome.tabs.get(tabId)
  }
  if (!tab?.active) throw new Error('Only active tabs can be captured in Chromium')
  const conf: any = { format: opts?.format === 'png' ? 'png' : 'jpeg' }
  if (opts?.quality !== undefined) conf.quality = opts.quality
  return chrome.tabs.captureVisibleTab(tab.windowId, conf)
}

const UPD_PROPS_MAP: Record<string, string[]> = {
  attention: [],
  audible: ['audible'],
  autoDiscardable: ['autoDiscardable'],
  discarded: ['discarded'],
  favIconUrl: ['favIconUrl'],
  hidden: [],
  isArticle: [],
  mutedInfo: ['mutedInfo'],
  pinned: ['pinned'],
  sharingState: [],
  status: ['status'],
  title: ['title'],
  url: ['url'],
}

const tabsNs = namespace(
  () => chrome.tabs,
  base => ({
    get: (id: number) => base.get(id).then(fxTab),
    getCurrent: () => base.getCurrent().then(fxTab),
    query: async (q: any = {}) => {
      if (q.hidden === true) return []
      const tabs: any[] = fxTabs(await base.query(pick(q, TAB_QUERY_KEYS)))
      if (q.cookieStoreId) {
        const ids = Array.isArray(q.cookieStoreId) ? q.cookieStoreId : [q.cookieStoreId]
        return tabs.filter(t => ids.includes(t.cookieStoreId))
      }
      return tabs
    },
    create: async (props: any = {}) => {
      const conf = pick(props, TAB_CREATE_KEYS)
      if ('url' in conf) {
        conf.url = urlIn(conf.url)
        if (conf.url === undefined) delete conf.url
      }
      const tab = await base.create(conf)
      if (props.muted) base.update(tab.id, { muted: true }).catch(() => {})
      return fxTab(tab)
    },
    update: async (tabId: any, props?: any) => {
      if (typeof tabId === 'object' && tabId !== null) {
        props = tabId
        tabId = undefined
      }
      const conf = pick(props, TAB_UPDATE_KEYS)
      if ('url' in conf) {
        conf.url = urlIn(conf.url) ?? 'chrome://newtab/'
      }
      if (!Object.keys(conf).length) {
        return tabId !== undefined ? base.get(tabId).then(fxTab) : undefined
      }
      const tab = tabId !== undefined ? await base.update(tabId, conf) : await base.update(conf)
      return fxTab(tab)
    },
    move: async (ids: any, props: any) => {
      const result = await base.move(ids, pick(props, ['index', 'windowId']))
      return fxTabs(Array.isArray(result) ? result : [result])
    },
    duplicate: async (tabId: number, props?: any) => {
      const tab = await base.duplicate(tabId)
      if (tab && props?.index !== undefined) {
        await base.move(tab.id, { index: props.index }).catch(() => {})
      }
      if (tab && props?.active === false) {
        await base.update(tabId, { active: true }).catch(() => {})
      }
      return fxTab(tab)
    },
    discard: async (ids?: number | number[]) => {
      if (ids === undefined) return
      const list = Array.isArray(ids) ? ids : [ids]
      await Promise.all(list.map(id => base.discard(id).catch(() => {})))
    },
    reload: (tabId?: number, props?: any) => {
      const conf = pick(props, ['bypassCache'])
      return tabId === undefined ? base.reload(conf) : base.reload(tabId, conf)
    },
    executeScript,
    captureTab,
    moveInSuccession: () => Promise.resolve(),
    warmup: () => Promise.resolve(),
    onCreated: wrapEvent(
      () => base.onCreated,
      ([tab]) => [fxTab(tab)]
    ),
    onUpdated: wrapEvent(
      () => base.onUpdated,
      ([tabId, change, tab], [filter]) => {
        if (change?.url) change.url = urlOut(change.url)
        fxTab(tab)
        if (filter) {
          if (filter.tabId !== undefined && filter.tabId !== tabId) return
          if (filter.windowId !== undefined && filter.windowId !== tab?.windowId) return
          if (filter.properties) {
            let match = false
            for (const p of filter.properties) {
              for (const key of UPD_PROPS_MAP[p] ?? [p]) {
                if (key in change) match = true
              }
            }
            if (!match) return
          }
        }
        return [tabId, change, tab]
      }
    ),
    onActivated: onActivated.event,
  })
)

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function fxWin(win: any) {
  if (win?.tabs) fxTabs(win.tabs)
  return win
}

const WIN_CREATE_KEYS = [
  'focused',
  'height',
  'incognito',
  'left',
  'setSelfAsOpener',
  'state',
  'tabId',
  'top',
  'type',
  'url',
  'width',
]
const WIN_UPDATE_KEYS = ['drawAttention', 'focused', 'height', 'left', 'state', 'top', 'width']

const windowsNs = namespace(
  () => chrome.windows,
  base => ({
    get: (id: number, q?: any) => base.get(id, q ?? {}).then(fxWin),
    getCurrent: (q?: any) => base.getCurrent(q ?? {}).then(fxWin),
    getLastFocused: (q?: any) => base.getLastFocused(q ?? {}).then(fxWin),
    getAll: (q?: any) => base.getAll(q ?? {}).then((wins: any[]) => wins.map(fxWin)),
    create: async (data: any = {}) => {
      const conf = pick(data, WIN_CREATE_KEYS)
      if (conf.url !== undefined) {
        const urls = (Array.isArray(conf.url) ? conf.url : [conf.url])
          .map(urlIn)
          .filter((u: any) => u !== undefined)
        if (urls.length) conf.url = urls
        else delete conf.url
      }
      // Chromium doesn't allow to set size/position for maximized/fullscreen windows
      if (conf.state && conf.state !== 'normal') {
        delete conf.left
        delete conf.top
        delete conf.width
        delete conf.height
      }
      return fxWin(await base.create(conf))
    },
    update: async (winId: number, info: any = {}) => {
      const conf = pick(info, WIN_UPDATE_KEYS)
      if (!Object.keys(conf).length) return base.get(winId)
      return base.update(winId, conf)
    },
  })
)

// ---------------------------------------------------------------------------
// Sessions (tab/window values are emulated with storage.session)
// ---------------------------------------------------------------------------
async function resolveWinId(winId: number): Promise<number> {
  if (winId === undefined || winId === null || winId === chrome.windows.WINDOW_ID_CURRENT) {
    return (await chrome.windows.getCurrent()).id
  }
  return winId
}

const tabValueKeys = new Set<string>(['data'])

if (IS_SW) {
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    const keys = [...tabValueKeys].map(k => `tv:${tabId}:${k}`)
    chrome.storage.session.remove(keys).catch(() => {})
  })
  chrome.windows.onRemoved.addListener((winId: number) => {
    chrome.storage.session
      .get(null)
      .then((all: any) => {
        const keys = Object.keys(all).filter(k => k.startsWith(`wv:${winId}:`))
        if (keys.length) return chrome.storage.session.remove(keys)
      })
      .catch(() => {})
  })
}

const sessionsNs = namespace(
  () => chrome.sessions ?? {},
  base => ({
    getRecentlyClosed: async (filter?: any) => {
      if (!base.getRecentlyClosed) return []
      const sessions: any[] = await base.getRecentlyClosed(filter ?? {})
      for (const s of sessions) {
        if (s.lastModified) s.lastModified *= 1000
        if (s.tab) fxTab(s.tab)
        if (s.window) fxWin(s.window)
      }
      return sessions
    },
    restore: async (id?: string) => {
      const s = await base.restore(id)
      if (s?.tab) fxTab(s.tab)
      if (s?.window) fxWin(s.window)
      return s
    },
    getTabValue: async (tabId: number, key: string) => {
      const k = `tv:${tabId}:${key}`
      return (await chrome.storage.session.get(k))[k]
    },
    setTabValue: async (tabId: number, key: string, value: any) => {
      tabValueKeys.add(key)
      await chrome.storage.session.set({ [`tv:${tabId}:${key}`]: value })
    },
    removeTabValue: async (tabId: number, key: string) => {
      await chrome.storage.session.remove(`tv:${tabId}:${key}`)
    },
    getWindowValue: async (winId: number, key: string) => {
      const k = `wv:${await resolveWinId(winId)}:${key}`
      return (await chrome.storage.session.get(k))[k]
    },
    setWindowValue: async (winId: number, key: string, value: any) => {
      const k = `wv:${await resolveWinId(winId)}:${key}`
      await chrome.storage.session.set({ [k]: value })
    },
    removeWindowValue: async (winId: number, key: string) => {
      const k = `wv:${await resolveWinId(winId)}:${key}`
      await chrome.storage.session.remove(k)
    },
    onChanged: wrapEvent(() => base.onChanged),
  })
)

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
const NO_RECEIVER_RE = /Receiving end does not exist|message port closed/i

/** Firefox-style onMessage: listener may return a promise with the response */
const onMessageWrappers = new Map<Fn, Fn>()
const fxOnMessage = {
  addListener(fn: Fn) {
    if (onMessageWrappers.has(fn)) return
    const wrapper = (msg: any, sender: any, sendResponse: Fn) => {
      let result: any
      try {
        result = fn(msg, sender, sendResponse)
      } catch (err) {
        console.error(err)
        return false
      }
      if (result === true) return true
      if (result && typeof result.then === 'function') {
        result.then(
          (v: any) => sendResponse(v),
          (err: any) => {
            console.error(err)
            sendResponse(undefined)
          }
        )
        return true
      }
      return false
    }
    onMessageWrappers.set(fn, wrapper)
    chrome.runtime.onMessage.addListener(wrapper)
  },
  removeListener(fn: Fn) {
    const wrapper = onMessageWrappers.get(fn)
    if (!wrapper) return
    onMessageWrappers.delete(fn)
    chrome.runtime.onMessage.removeListener(wrapper)
  },
  hasListener(fn: Fn) {
    return onMessageWrappers.has(fn)
  },
}

const runtimeNs = namespace(
  () => chrome.runtime,
  base => ({
    getBrowserInfo: async () => {
      const ua = (globalThis as any).navigator?.userAgent ?? ''
      const ver = /Chrom(?:e|ium)\/([\d.]+)/.exec(ua)?.[1] ?? '0'
      return { name: 'Chromium', vendor: 'Chromium', version: ver, buildID: '' }
    },
    sendMessage: (...args: any[]) => {
      return base.sendMessage(...args).catch((err: any) => {
        if (NO_RECEIVER_RE.test(String(err?.message ?? err))) return undefined
        throw err
      })
    },
    onMessage: fxOnMessage,
  })
)

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
const UNSUPPORTED_PERMISSIONS = new Set([
  'tabHide',
  'webRequestBlocking',
  'menus',
  'menus.overrideContext',
  'contextualIdentities',
  'proxy',
  'theme',
  'publicSuffix',
  'browserSettings',
  'sessionstore',
])

function splitPerms(p: any) {
  const perms: string[] = p?.permissions ?? []
  const supported = perms.filter(x => !UNSUPPORTED_PERMISSIONS.has(x))
  const hasUnsupported = supported.length !== perms.length
  const out: any = {}
  if (p?.origins?.length) out.origins = p.origins
  if (supported.length) out.permissions = supported
  return { out, hasUnsupported, empty: !out.origins && !out.permissions }
}

const permissionsNs = namespace(
  () => chrome.permissions,
  base => ({
    contains: async (p: any) => {
      const { out, hasUnsupported, empty } = splitPerms(p)
      if (hasUnsupported) return false
      if (empty) return true
      return base.contains(out)
    },
    request: async (p: any) => {
      const { out, hasUnsupported, empty } = splitPerms(p)
      if (hasUnsupported) return false
      if (empty) return true
      return base.request(out)
    },
    remove: async (p: any) => {
      const { out, empty } = splitPerms(p)
      if (empty) return true
      return base.remove(out)
    },
  })
)

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
const MENU_CONTEXTS: Record<string, string | undefined> = {
  all: 'all',
  page: 'page',
  frame: 'frame',
  selection: 'selection',
  link: 'link',
  editable: 'editable',
  image: 'image',
  video: 'video',
  audio: 'audio',
  browser_action: 'action',
  action: 'action',
}
const MENU_KEYS = [
  'checked',
  'contexts',
  'documentUrlPatterns',
  'enabled',
  'id',
  'parentId',
  'targetUrlPatterns',
  'title',
  'type',
  'visible',
]

function menuProps(props: any): any | undefined {
  const conf = pick(props, MENU_KEYS)
  if (conf.contexts) {
    conf.contexts = conf.contexts.map((c: string) => MENU_CONTEXTS[c]).filter(Boolean)
    if (!conf.contexts.length) return undefined
  }
  return conf
}

const menusNs = namespace(
  () => chrome.contextMenus ?? {},
  base => ({
    create: (props: any, cb?: Fn) => {
      const conf = menuProps(props)
      if (!conf || !base.create) {
        cb?.()
        return props?.id
      }
      return base.create(conf, () => {
        ignoreLastError()
        cb?.()
      })
    },
    update: (id: any, props: any) => {
      if (!base.update) return Promise.resolve()
      return base.update(id, menuProps(props) ?? {}).catch(() => {})
    },
    remove: (id: any) => (base.remove ? base.remove(id).catch(() => {}) : Promise.resolve()),
    removeAll: () => (base.removeAll ? base.removeAll() : Promise.resolve()),
    refresh: () => Promise.resolve(),
    overrideContext: () => {},
    getTargetElement: () => null,
    onClicked: wrapEvent(
      () => base.onClicked,
      ([info, tab]) => [{ button: 0, modifiers: [], ...info }, fxTab(tab)]
    ),
    onShown: dummyEvent(),
    onHidden: dummyEvent(),
  })
)

// ---------------------------------------------------------------------------
// Toolbar button / sidebar
// ---------------------------------------------------------------------------
const actionNs = namespace(
  () => chrome.action,
  base => ({
    setPopup: (details: any) => base.setPopup({ ...details, popup: details?.popup ?? '' }),
    openPopup: (opts?: any) => (base.openPopup ? base.openPopup(opts ?? {}) : Promise.resolve()),
    setIcon: (details: any) => {
      // SVG icons are not supported by chromium
      const p = details?.path
      if (typeof p === 'string' && p.endsWith('.svg')) return Promise.resolve()
      if (p && typeof p === 'object' && Object.values(p).some((v: any) => `${v}`.endsWith('.svg'))) {
        return Promise.resolve()
      }
      return base.setIcon(details)
    },
    onClicked: wrapEvent(
      () => base.onClicked,
      ([tab]) => [fxTab(tab), { button: 0, modifiers: [] }]
    ),
  })
)

let currentWinId: number | undefined
if (!IS_SW) {
  chrome.windows
    ?.getCurrent()
    .then((w: any) => (currentWinId = w.id))
    .catch(() => {})
}

async function isSidePanelOpen(windowId?: number): Promise<boolean> {
  if (!chrome.runtime.getContexts) return false
  const filter: any = { contextTypes: ['SIDE_PANEL'] }
  if (windowId !== undefined && windowId !== null && windowId >= 0) filter.windowIds = [windowId]
  const contexts = await chrome.runtime.getContexts(filter)
  return contexts.length > 0
}

const sidebarAction = {
  setTitle: () => Promise.resolve(),
  getTitle: () => Promise.resolve('Sidebery'),
  setIcon: () => Promise.resolve(),
  setPanel: () => Promise.resolve(),
  getPanel: () => Promise.resolve(chrome.runtime.getURL('sidebar/sidebar.html')),
  isOpen: (details?: any) => isSidePanelOpen(details?.windowId),
  open: () => {
    if (currentWinId === undefined) return Promise.resolve()
    return chrome.sidePanel.open({ windowId: currentWinId })
  },
  close: () => {
    if (currentWinId === undefined || !chrome.sidePanel.close) return Promise.resolve()
    return chrome.sidePanel.close({ windowId: currentWinId })
  },
  toggle: async () => {
    if (await isSidePanelOpen(currentWinId)) return sidebarAction.close()
    return sidebarAction.open()
  },
}

const pageAction = {
  show: () => Promise.resolve(),
  hide: () => Promise.resolve(),
  setTitle: () => Promise.resolve(),
  setIcon: () => Promise.resolve(),
  setPopup: () => Promise.resolve(),
  isShown: () => Promise.resolve(false),
  onClicked: dummyEvent(),
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------
const BKM_OUT: Record<string, string> = {
  '0': 'root________',
  '1': 'toolbar_____',
  '2': 'unfiled_____',
  '3': 'mobile______',
}
const BKM_IN: Record<string, string> = {
  root________: '0',
  toolbar_____: '1',
  unfiled_____: '2',
  mobile______: '3',
  menu________: '2',
}
const bIn = (id: any) => (id === undefined || id === null ? id : BKM_IN[id] ?? id)
const bOut = (id: any) => (id === undefined || id === null ? id : BKM_OUT[id] ?? id)
const bInList = (ids: any) => (Array.isArray(ids) ? ids.map(bIn) : bIn(ids))

function fxNode(node: any): any {
  if (!node || typeof node !== 'object') return node
  node.id = bOut(node.id)
  if (node.parentId !== undefined) node.parentId = bOut(node.parentId)
  if (!node.type) node.type = node.url !== undefined ? 'bookmark' : 'folder'
  if (node.children) node.children.forEach(fxNode)
  return node
}
const fxNodes = (nodes: any) => (Array.isArray(nodes) ? nodes.map(fxNode) : nodes)

const bookmarksNs = namespace(
  () => chrome.bookmarks,
  base => ({
    get: (ids: any) => base.get(bInList(ids)).then(fxNodes),
    getChildren: (id: any) => base.getChildren(bIn(id)).then(fxNodes),
    getRecent: (n: number) => base.getRecent(n).then(fxNodes),
    getSubTree: (id: any) => base.getSubTree(bIn(id)).then(fxNodes),
    getTree: () => base.getTree().then(fxNodes),
    search: (q: any) => base.search(q).then(fxNodes),
    create: async (details: any = {}) => {
      if (details.type === 'separator') {
        throw new Error('Bookmark separators are not supported in Chromium')
      }
      const conf = pick(details, ['index', 'parentId', 'title', 'url'])
      if (details.type === 'folder') delete conf.url
      if (conf.parentId !== undefined) conf.parentId = bIn(conf.parentId)
      return fxNode(await base.create(conf))
    },
    move: async (id: any, dst: any = {}) => {
      const conf = pick(dst, ['index', 'parentId'])
      if (conf.parentId !== undefined) conf.parentId = bIn(conf.parentId)
      return fxNode(await base.move(bIn(id), conf))
    },
    update: async (id: any, changes: any) => {
      return fxNode(await base.update(bIn(id), pick(changes, ['title', 'url'])))
    },
    remove: (id: any) => base.remove(bIn(id)),
    removeTree: (id: any) => base.removeTree(bIn(id)),
    onCreated: wrapEvent(
      () => base.onCreated,
      ([id, node]) => [bOut(id), fxNode(node)]
    ),
    onRemoved: wrapEvent(
      () => base.onRemoved,
      ([id, info]) => {
        if (info) {
          info.parentId = bOut(info.parentId)
          if (info.node) fxNode(info.node)
        }
        return [bOut(id), info]
      }
    ),
    onChanged: wrapEvent(
      () => base.onChanged,
      ([id, info]) => [bOut(id), info]
    ),
    onMoved: wrapEvent(
      () => base.onMoved,
      ([id, info]) => {
        if (info) {
          info.parentId = bOut(info.parentId)
          info.oldParentId = bOut(info.oldParentId)
        }
        return [bOut(id), info]
      }
    ),
  })
)

// ---------------------------------------------------------------------------
// Misc namespaces
// ---------------------------------------------------------------------------
const historyNs = namespace(
  () => chrome.history,
  _ => ({
    onTitleChanged: dummyEvent(),
  })
)

const cookiesNs = namespace(
  () => chrome.cookies,
  base => {
    const clean = (d: any) => {
      const conf = { ...(d ?? {}) }
      if (typeof conf.storeId === 'string' && conf.storeId.startsWith('firefox-')) delete conf.storeId
      delete conf.firstPartyDomain
      return conf
    }
    return {
      get: (d: any) => base.get(clean(d)),
      getAll: (d: any) => base.getAll(clean(d)),
      remove: (d: any) => base.remove(clean(d)),
      set: (d: any) => base.set(clean(d)),
    }
  }
)

const commandsNs = namespace(
  () => chrome.commands,
  base => ({
    onCommand: wrapEvent(() => base.onCommand),
    update: () => Promise.reject(new Error('Use chrome://extensions/shortcuts to change shortcuts')),
    reset: () => Promise.reject(new Error('Use chrome://extensions/shortcuts to change shortcuts')),
  })
)

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const omniboxNs = namespace(
  () => chrome.omnibox,
  base => ({
    setDefaultSuggestion: (s: any) =>
      base.setDefaultSuggestion({ description: escapeXml(s?.description ?? '') }),
    onInputChanged: wrapEvent(
      () => base.onInputChanged,
      ([text, suggest]) => [
        text,
        (results: any[]) =>
          suggest(
            (results ?? []).map(r => ({
              content: r.content,
              description: escapeXml(r.description ?? r.content ?? ''),
            }))
          ),
      ]
    ),
  })
)

const searchNs = namespace(
  () => chrome.search,
  base => ({
    search: (props: any = {}) => {
      const conf: any = { text: props.query ?? '' }
      if (props.tabId !== undefined) conf.tabId = props.tabId
      else if (props.disposition) conf.disposition = props.disposition
      return base.query(conf)
    },
    get: () => Promise.resolve([]),
  })
)

const webRequestNs = namespace(
  () => chrome.webRequest,
  base => {
    const out: Record<string, any> = {}
    for (const name of Object.keys(Object.getPrototypeOf(base) ?? {}).concat(Object.keys(base))) {
      const ev = base[name]
      if (!name.startsWith('on') || !ev?.addListener) continue
      out[name] = {
        addListener(fn: Fn, filter: any, spec?: string[]) {
          try {
            const s = spec?.filter(x => x !== 'blocking')
            ev.addListener(fn, filter, s?.length ? s : undefined)
          } catch (err) {
            console.warn('webRequest listener is not supported:', name, err)
          }
        },
        removeListener: (fn: Fn) => ev.removeListener(fn),
        hasListener: (fn: Fn) => ev.hasListener(fn),
      }
    }
    return out
  }
)

const contextualIdentities = {
  query: () => Promise.resolve([]),
  get: () => Promise.reject(new Error('Containers are not supported in Chromium')),
  create: () => Promise.reject(new Error('Containers are not supported in Chromium')),
  update: () => Promise.reject(new Error('Containers are not supported in Chromium')),
  remove: () => Promise.reject(new Error('Containers are not supported in Chromium')),
  move: () => Promise.reject(new Error('Containers are not supported in Chromium')),
  onCreated: dummyEvent(),
  onUpdated: dummyEvent(),
  onRemoved: dummyEvent(),
}

const theme = {
  getCurrent: () => Promise.resolve({ colors: null, images: null, properties: null }),
  update: () => Promise.resolve(),
  reset: () => Promise.resolve(),
  onUpdated: dummyEvent(),
}

const proxy = {
  onRequest: dummyEvent(),
  onError: dummyEvent(),
  settings: {
    get: () => Promise.resolve({ value: {} }),
    set: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  },
}

// ---------------------------------------------------------------------------
// The `browser` object
// ---------------------------------------------------------------------------
const browser: any = {}
const define = (name: string, get: () => any) => {
  Object.defineProperty(browser, name, { get, enumerable: true, configurable: true })
}
const passThrough = (name: string) => define(name, () => chrome[name])

define('tabs', tabsNs)
define('windows', windowsNs)
define('sessions', sessionsNs)
define('runtime', runtimeNs)
define('permissions', permissionsNs)
define('menus', menusNs)
define('contextMenus', menusNs)
define('browserAction', actionNs)
define('action', actionNs)
define('bookmarks', bookmarksNs)
define('history', historyNs)
define('cookies', cookiesNs)
define('commands', commandsNs)
define('omnibox', omniboxNs)
define('search', searchNs)
define('webRequest', webRequestNs)
define('sidebarAction', () => sidebarAction)
define('pageAction', () => pageAction)
define('contextualIdentities', () => contextualIdentities)
define('theme', () => theme)
define('proxy', () => proxy)
for (const name of [
  'storage',
  'extension',
  'i18n',
  'identity',
  'downloads',
  'alarms',
  'notifications',
  'scripting',
  'sidePanel',
  'tabGroups',
  'idle',
]) {
  passThrough(name)
}

g.browser = browser

export {}
