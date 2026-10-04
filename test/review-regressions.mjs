/** Regression checks for the user workflows found in the 0.2.7 review. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, Config } from '../lib/index.js'
import { resolveLiveRefs } from '../lib/compat.js'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/store.js'
import { streamErrorCode } from '../lib/adapter.js'
import { injectPrefs, buildAttempts, channelNameFor, pinAdherence } from '../lib/protocol.js'

let passed = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); passed += 1 }
const requests = []
let chatResponder = () => Response.json({ choices: [{ message: { content: 'OK' } }] })
const previousFetch = globalThis.fetch
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/chat/completions')) {
    const request = { url: String(url), authorization: options.headers?.authorization ?? options.headers?.Authorization, body: JSON.parse(options.body) }
    requests.push(request)
    return chatResponder(request)
  }
  // No external calls, no real credentials. All catalogs stay empty.
  return Response.json({})
}
const model = 'cline-pass/glm-5.2'
const base = 'http://review-primary.invalid/api/v1'
const backupBase = 'http://review-backup.invalid/api/v1'
const key = (name) => `sk_review_synthetic_${name}_123456789`
const profile = (ref, baseURL = '') => ({ displayName: ref, apiKeyEnv: ref, enabled: true, baseURL })
const deepMerge = (a, b) => {
  const next = { ...a }
  for (const [k, v] of Object.entries(b)) {
    next[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] ?? {}, v) : v
  }
  return next
}
function host(overrides = {}, credentialValues = {}, withSettings = true) {
  let section = resolveLiveRefs(Config({ baseURL: base, knownModels: [model], exposeTools: true, ...overrides }))
  const credentials = new Map(Object.entries(credentialValues))
  const definitions = new Map()
  let adapter
  let route
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    credentials: {
      resolve: async (ref) => credentials.has(String(ref)) ? { value: credentials.get(String(ref)), source: 'review' } : undefined,
      set: async (ref, value) => credentials.set(String(ref), value),
    },
    settings: withSettings ? {
      installSection(_owner, _ns, _schema, _entry, hooks) { hooks.setSource(() => section) },
      update: async (_ns, patch) => { section = deepMerge(section, patch) },
      mutate: async (_ns, ops) => {
        const unset = (source, [head, ...tail]) => {
          const next = { ...source }
          if (tail.length === 0) delete next[head]
          else next[head] = unset(next[head], tail)
          return next
        }
        for (const op of ops) {
          section = unset(section, op.path)
        }
      },
    } : undefined,
    get(name) { return this[name] },
    inject(names, callback) { if (names.every((name) => this[name] !== undefined)) callback(this) },
    llm: { registerAdapter(_routes, instance) { adapter = instance }, registerConfigurableProviders() {} },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
    connection: { fetch: { register(definition) { route = definition.fetch; return () => {} } } },
  }
  apply(ctx, { ...section })
  return {
    adapter, credentials,
    config: () => section,
    call: (name, args) => definitions.get(name).execute(args, { signal: new AbortController().signal }),
    rpc: async (endpoint, payload = {}) => {
      const response = await route(new Request('http://localhost/api/cline-pass', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
      const result = await response.json()
      assert.equal(result.ok, true, JSON.stringify(result.error))
      return result.value
    },
  }
}
async function runAdapter(h) {
  const chunks = []
  let error
  try {
    for await (const chunk of h.adapter.stream({ provider: 'cline-pass', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'review' }] }] })) chunks.push(chunk)
  } catch (e) { error = { code: e.code, message: e.message } }
  return { chunks, error }
}
const streamingOK = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

try {
  chatResponder = streamingOK
  for (const mode of ['single', 'roundrobin']) {
    const h = host({ accounts: { primary: profile('REVIEW_MISSING'), backup: profile('REVIEW_BACKUP') }, activeAccount: 'primary', accountMode: mode }, { REVIEW_BACKUP: key('backup') })
    const before = requests.length
    const result = await runAdapter(h)
    check(result.error, undefined, `${mode}: missing primary does not prevent an answer`)
    check(result.chunks.some((c) => c.type === 'text-delta'), true, 'backup delivers content')
    check(requests.length - before, 1, 'only the usable account reaches the gateway')
    check((await h.rpc('state')).effectiveAccount, 'backup', 'quota follows the usable account')
  }
  const unconfigured = host({ accounts: { primary: profile('REVIEW_MISSING') } })
  check((await runAdapter(unconfigured)).error?.code, 'MISSING_CREDENTIAL', 'all missing credentials retain a useful error')
  check((await unconfigured.rpc('state')).ready, false, 'unusable pool is not reported ready')

  for (const face of ['panel', 'tool']) {
    const h = host({}, { CLINE_PASS_API_KEY: key('default') })
    const add = async (name, value) => face === 'panel'
      ? h.rpc('account.add', { name, key: value })
      : h.call('cline_pass_accounts', { action: 'add', name, key: value })
    for (const name of ['foo.bar', 'foo-bar', 'foo_bar', 'MAIN', 'main']) await add(name, key(name))
    const entries = Object.entries(h.config().accounts).filter(([name]) => name !== 'default')
    check(new Set(entries.map(([, a]) => a.apiKeyEnv)).size, 5, `${face}: distinct account names have separate credentials`)
    for (const [name, a] of entries) check(h.credentials.get(a.apiKeyEnv), key(name), `${face}: adding another account preserves ${name}'s key`)
    const before = h.config().accounts['foo.bar'].apiKeyEnv
    await add('foo.bar', key('updated'))
    check(h.config().accounts['foo.bar'].apiKeyEnv, before, 'updating preserves the allocated reference')

    const custom = host({ accounts: { backup: { ...profile('REVIEW_CUSTOM', backupBase), enabled: false } } }, { REVIEW_CUSTOM: key('old') })
    if (face === 'panel') await custom.rpc('account.add', { name: 'backup', key: key('new') })
    else await custom.call('cline_pass_accounts', { action: 'add', name: 'backup', key: key('new') })
    check(custom.config().accounts.backup, { ...profile('REVIEW_CUSTOM', backupBase), enabled: false }, `${face}: key rotation preserves all unspecified account fields`)
    check(custom.credentials.get('REVIEW_CUSTOM'), key('new'), 'new key is stored under the original reference')
  }

  const replacement = host({ accounts: { primary: profile('REVIEW_A'), backup: profile('REVIEW_B') }, activeAccount: 'primary' }, { REVIEW_A: key('a'), REVIEW_B: key('b') })
  const changed = await replacement.call('cline_pass_accounts', { action: 'set', accounts: [{ name: 'backup', apiKeyEnv: 'REVIEW_B' }] })
  check(changed.accounts.map((a) => a.key), ['backup'], 'set removes omitted accounts under recursive settings merge')
  check(changed.activeAccount, '', 'removing active account clears stale selection')
  await replacement.call('cline_pass_accounts', { action: 'set', accounts: [] })
  check(Object.keys(replacement.config().accounts), [], 'empty set removes all explicit accounts')

  for (const status of [401, 403]) {
    chatResponder = (r) => r.authorization === `Bearer ${key('a')}` ? new Response('', { status }) : streamingOK()
    const h = host({ accounts: { primary: profile('REVIEW_A'), backup: profile('REVIEW_B') }, activeAccount: 'primary' }, { REVIEW_A: key('a'), REVIEW_B: key('b') })
    const before = requests.length
    check((await runAdapter(h)).error, undefined, `HTTP ${status} without a body fails over`)
    check(requests.length - before, 2, 'both accounts get a chance')
    check(streamErrorCode('', status), 'AUTH', 'HTTP status is sufficient to identify authentication refusal')
    check((await h.rpc('state')).effectiveAccount, 'backup', 'authentication cooldown applies to subsequent requests')
  }

  for (const [status, body] of [[401, ''], [403, '{"error":{"message":"Forbidden"}}'], [500, '<html>bad gateway</html>'], [200, '{}'], [400, '{"error":{"message":"Invalid_API_Key"}}'], [400, '{"error":{"message":"Access denied"}}']]) {
    chatResponder = () => new Response(body, { status })
    const store = createStore()
    store.learn(model, { pipeline: 'planner', pinnable: true, upstreams: ['alibaba'] })
    const engine = createEngine({ resolveAccount: async () => ({ name: 'review', key: key('review'), baseURL: base }), store })
    const tested = await engine.testAccount({ key: key('review'), baseURL: base, model })
    check(tested.authorized, false, `HTTP ${status}: failure/malformed result is not proof of authorization`)
    check((await engine.probe(model)).ok, false, 'failed probe reports failure')
    check(store.metaOf(model).pipeline, 'planner', 'failed probe preserves known pipeline')
  }
  chatResponder = () => Response.json({ error: { message: 'unsupported model' } }, { status: 400 })
  const engine = createEngine({ resolveAccount: async () => ({ name: 'review', key: key('review'), baseURL: base }), store: createStore() })
  check((await engine.testAccount({ key: key('review'), baseURL: base, model })).authorized, true, 'model-specific refusal does not invalidate an authenticated key')
  chatResponder = () => Response.json({ error: 'unauthorized' }, { status: 401 })
  const testedHost = host({}, { CLINE_PASS_API_KEY: key('default') })
  check((await testedHost.call('cline_pass_accounts', { action: 'test', key: key('typed') })).ok, false, 'tool authentication result is not always true')

  chatResponder = () => Response.json({ choices: [{ message: { content: 'OK' } }] })
  const endpoints = host({ accounts: { backup: profile('REVIEW_BACKUP', backupBase) } }, { REVIEW_BACKUP: key('stored') })
  await endpoints.rpc('key.test', { ref: 'REVIEW_BACKUP', value: key('typed') })
  check(requests.at(-1).url, `${backupBase}/chat/completions`, 'typed key uses the account endpoint')
  await endpoints.rpc('key.test', { ref: 'REVIEW_BACKUP' })
  check(requests.at(-1).url, `${backupBase}/chat/completions`, 'stored key uses the same endpoint')
  await endpoints.call('cline_pass_accounts', { action: 'test', name: 'backup', key: key('typed') })
  check(requests.at(-1).url, `${backupBase}/chat/completions`, 'tool typed key uses the account endpoint')

  const validationStore = createStore()
  validationStore.learn(model, { upstreams: ['alibaba'] })
  validationStore.learnUpstream(model, 'alibaba', 'ok', '', 1)
  const validation = createEngine({ resolveAccount: async () => ({ name: 'review', key: key('review'), baseURL: base }), store: validationStore })
  check((await validation.validate(model)).summary, { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 1 }, 'unreported routing does not verify a pinned channel')
  check(validationStore.metaOf(model).upstreamStatus.alibaba.status, 'unknown', 'fresh inconclusive validation replaces an old available verdict')

  const headless = host({}, { CLINE_PASS_API_KEY: key('headless') }, false)
  check((await headless.call('cline_pass_pin', { model, upstreams: ['alibaba'] })).pinned, ['alibaba'], 'in-memory pin updates are read back')
  check((await headless.rpc('model.visibility', { model, visible: false })).models[0].hidden, true, 'in-memory visibility update takes effect')
  await headless.call('cline_pass_accounts', { action: 'add', name: 'backup', key: key('backup') })
  await headless.call('cline_pass_accounts', { action: 'set', accounts: [{ name: 'backup' }] })
  check((await headless.rpc('state')).accounts.map((a) => a.key), ['backup'], 'in-memory removal semantics match settings')

  const meta = { pipeline: 'planner', upstreams: ['zai', 'alibaba'], channels: { planner: ['zai', 'alibaba'], direct: ['z-ai', 'alibaba'] } }
  for (const exclude of ['zai', 'z-ai', 'Z.AI']) {
    const attempt = buildAttempts({ upstreams: [], exclude: [exclude] })[0]
    const wire = injectPrefs({ model }, meta, attempt)
    check(wire.providerOptions.gateway.only, ['alibaba'], 'planner excludes the same channel under every supported alias')
    check(wire.provider.only, ['alibaba'], 'direct excludes the same channel under every supported alias')
    check(buildAttempts({ upstreams: ['zai', 'alibaba'], exclude: [exclude] }).map((a) => a.upstream), ['alibaba'], 'excluded alias is not attempted as a strict pin')
  }

  chatResponder = () => new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const emptyHost = host({}, { CLINE_PASS_API_KEY: key('empty') })
  check((await runAdapter(emptyHost)).chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE', 'empty completion still fails for the caller')
  const emptyHistory = await emptyHost.rpc('history')
  check(emptyHistory.entries[0].code, 'EMPTY_RESPONSE', 'history retains the caller error code')
  check(emptyHistory.entries[0].error.length > 0, true, 'history identifies a failed completion')

  const capped = createStore({ historyLimit: 2 })
  for (let i = 0; i < 3; i++) capped.record({ model, seq: i })
  check(capped.historySize(), 2, 'retention cap is preserved')
  check(capped.historyRevision(), 3, 'revision advances even at the retention cap')
} finally { globalThis.fetch = previousFetch }

// Run the shipped browser components with persistent hook state and React's
// dependency/key semantics; no DOM or network is needed for these regressions.
const effects = []
let slots = []
let cursor = 0
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } })
const react = {
  createElement: h,
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
  useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
  useEffect(callback, deps) {
    const i = cursor++, prior = slots[i]
    if (!prior || deps.some((v, j) => !Object.is(v, prior.deps[j]))) {
      prior?.cleanup?.()
      effects.push(() => { slots[i] = { deps, cleanup: callback() } })
    }
  },
}
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace('exports.apply = apply', 'exports.__review = { Panel, AccountsCard, KeyField, ModelRow, historyStamp }; exports.apply = apply')
let client
const priorWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load(entry) { client = entry.factory((specifier) => specifier === 'react' ? react : {}) } } }
try { new Function(source)() } finally { globalThis.window = priorWindow }
const walk = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.props?.children ?? []) { const found = walk(child, predicate); if (found) return found }
}
const historyStore = createStore({ historyLimit: 2 })
historyStore.record({ model, seq: 0 }); historyStore.record({ model, seq: 1 })
let historyLoads = 0
let state = { data: null, busy: null, notice: null, status: 'ready', error: null }
const panelProps = { t: (k) => k, useClinePass: () => state, loadHistory: async () => { historyLoads++; return { entries: historyStore.readHistory(25), total: historyStore.historySize() } } }
const renderPanel = async () => {
  cursor = 0
  client.__review.Panel(panelProps)
  while (effects.length) effects.shift()()
  await Promise.resolve()
}
const data = { ready: false, settingsAvailable: true, accounts: [], accountMode: 'single', activeAccount: '', models: [], historySize: 2, historyRevision: historyStore.historyRevision() }
state = { ...state, data }
await renderPanel()
historyStore.record({ model, seq: 2 })
state = { ...state, data: { ...data, historyRevision: historyStore.historyRevision() } }
await renderPanel()
check(historyLoads, 2, 'mounted history rereads at the retention cap')
check(slots[0].entries[0].seq, 2, 'latest retained request reaches the visible history')

const accountA = { key: 'A', displayName: 'A', enabled: true, apiKeyEnv: 'REVIEW_A' }
const accountB = { key: 'B', displayName: 'B', enabled: true, apiKeyEnv: 'REVIEW_B' }
const cardProps = (activeAccount) => ({ t: (k) => k, disabled: false, ready: true, data: { accounts: [accountA, accountB], activeAccount, accountMode: 'single' }, actions: {} })
const renderCard = (activeAccount) => { cursor = 0; slots = []; return client.__review.AccountsCard(cardProps(activeAccount)) }
const fieldA = walk(renderCard('A'), (node) => node.type === client.__review.KeyField)
slots = []; cursor = 0
walk(client.__review.KeyField(fieldA.props), (node) => node.type === 'input').props.onChange({ target: { value: key('draft-A') } })
const fieldSlots = slots
const fieldB = walk(renderCard('B'), (node) => node.type === client.__review.KeyField)
check(fieldA.props.key === fieldB.props.key, false, 'account switches change React component identity')
// React remounts a component when its key changes.
slots = fieldA.props.key === fieldB.props.key ? fieldSlots : []; cursor = 0
const second = client.__review.KeyField(fieldB.props)
check(walk(second, (node) => node.type === 'input').props.value, '', 'account B never inherits account A draft')
check(walk(second, (node) => node.props?.key === 'saveOnly').props.disabled, true, 'saving a previous account draft is prevented')

let validated
slots = [true]; cursor = 0
const row = client.__review.ModelRow({ t: (k) => k, model: { id: model, pinned: [], upstreams: [], excluded: [] }, actions: { validateModel: (id) => { validated = id } } })
const validateButton = walk(row, (node) => node.type === 'button' && node.props.key === 'validate')
check(validateButton !== undefined, true, 'channel validation has a visible model-row entry')
validateButton.props.onClick()
check(validated, model, 'the validation button calls the selected model')
check(client.__review.historyStamp(NaN), '-', 'history timestamps retain invalid-date handling')
check(client.__review.historyStamp(Date.now()).length, 8, 'today history uses compact clock timestamps')
console.log(`✔ all ${passed} review regression checks passed`)
