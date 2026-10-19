/**
 * Transport for the Cline gateway and its public catalogs. Transport only: no
 * pinning, retry, or failover policy lives here (see `adapter.js`).
 *
 * - `POST {baseURL}/chat/completions` — the gateway
 * - `GET  {baseURL}/models` — the gateway's own catalog
 * - `GET  {baseURL}/users/me/plan/usage-limits` — the account's quota windows
 * - `GET  {baseURL}/users/{id}/usages` — the per-request usage history behind them
 * - `GET  api.cline.bot/.../recommended-models` — official subscription list
 * - `GET  models.dev/api.json` — community registry, a backstop
 * - `GET  ai-gateway.vercel.sh/v1/models` — the upstream's own catalog
 * - `GET  openrouter.ai/api/v1/...` — endpoint detail for direct-pipeline models
 *
 * @module dsh-cline-pass/cline
 */

import { REASONING_EFFORTS } from './catalog.js'
/** The public Cline endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
/** The authenticated sub-path that reports quota consumption for the account. */
export const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'
/** The authenticated sub-path naming the account the usage history belongs to. */
export const PROFILE_PATH = '/users/me'
/** The authenticated sub-path carrying the account's plan and its quota caps. */
export const PLAN_PATH = '/users/me/plan'
/**
 * How many usage rows one history page returns.
 *
 * 200 is what the gateway actually hands back: asking for more is accepted and
 * silently capped, which is how a "6 page" walk can cover far less history than
 * the arithmetic suggests.
 */
export const USAGE_PAGE_SIZE = 200
/** How many history pages one row-level walk reads before it reports partial data. */
export const USAGE_MAX_PAGES = 12
/** One day in milliseconds; the line between a window read row by row and per day. */
const DAY_MS = 86_400_000
/** How many models one window reports before the tail is summarised by count. */
export const MODEL_ROWS_MAX = 8
/** The community model registry. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'
/**
 * The upstream gateway's own model catalog.
 *
 * It is the only source that publishes the reasoning levels behind a Cline Pass
 * model. Cline Pass does not: its `/models` carries ids only, and its gateway
 * accepts every level in the harness vocabulary for every model, so an unsupported
 * one cannot even be probed out — a level outside the vocabulary is the only
 * rejection it makes. The route is named in the gateway's own failures
 * (`… from Vercel`), and that catalog is open.
 */
export const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models'
/** OpenRouter's public API, used only for direct-pipeline endpoint detail. */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1'

/** Combine a caller signal with a timeout signal. */
function withTimeout(signal, timeoutMs) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Strip a trailing slash so paths can be appended literally. */
export function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/**
 * The gateway's own chat-completions endpoint for one base URL.
 * @param baseURL - e.g. `https://api.cline.bot/api/v1`.
 */
export function chatURL(baseURL) {
  return `${trimBase(baseURL)}/chat/completions`
}

/**
 * Send one JSON request and decode whatever comes back.
 * @returns `{ status, ok, json, text }`; never throws for an HTTP error status.
 */
export async function sendJSON(url, { method = 'GET', apiKey = '', body, signal, timeoutMs = 60000, headers = {} } = {}) {
  const outgoing = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  }
  const response = await fetch(url, outgoing)
  const text = await response.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

/**
 * Send one chat completion, non-streaming.
 * @returns `{ status, ok, json, text }` with the gateway envelope already unwrapped by the caller.
 */
export function chatCompletion(options) {
  const { baseURL, apiKey, body, signal, timeoutMs = 180000 } = options
  return sendJSON(chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs })
}

/**
 * Open a streaming chat completion and hand back the live response.
 * @returns the raw `fetch` Response so the caller owns SSE iteration and abort.
 */
export async function openChatStream({ baseURL, apiKey, body, signal, headers = {} }) {
  return await fetch(chatURL(baseURL), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Read the metadata one catalog source publishes about a model.
 *
 * models.dev nests the readable modalities under `modalities.input` and the
 * caps under `limit`. The cline.api list is a flat array of ids, so it yields
 * nothing here and contributes only membership. Fields the source omits stay
 * absent rather than becoming a guess: the resolver's own fallbacks are the one
 * place a missing value is interpreted.
 *
 * @returns the subset of `{ name, contextWindow, maxTokens, inputModalities }`
 *   this entry supplies.
 */
function modelMetadata(entry) {
  const meta = {}
  const name = entry?.name
  if (typeof name === 'string' && name.trim().length > 0) meta.name = name.trim()
  // Both spellings have been seen: `modalities.input` (current) and a flat
  // `input` some entries on other providers carry.
  const modalities = entry?.modalities?.input ?? entry?.input
  if (Array.isArray(modalities)) {
    const input = modalities.filter((value) => typeof value === 'string' && value.length > 0)
    if (input.length > 0) meta.inputModalities = input
  }
  const contextWindow = entry?.limit?.context ?? entry?.contextWindow
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) meta.contextWindow = contextWindow
  const maxTokens = entry?.limit?.output ?? entry?.maxTokens
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) meta.maxTokens = maxTokens
  return meta
}

/**
 * The reasoning levels one model offers, from the upstream's `reasoning_options`.
 *
 * An `effort` entry names the levels; a `toggle` entry is the model's on/off switch,
 * which in the harness vocabulary is `none`. Returned in escalating order so the
 * picker reads in one direction whatever order the catalog happened to list.
 *
 * Models published with only a toggle, or only a token budget, name no levels at
 * all. Those return undefined rather than an invented list, and the caller keeps the
 * full vocabulary — narrowing a model to a single `none` would take away the switch
 * the catalog just described.
 *
 * @returns the level ids, or undefined when the entry names none.
 */
function effortsFromOptions(options) {
  if (!Array.isArray(options)) return undefined
  const levels = new Set()
  let toggle = false
  for (const option of options) {
    if (option?.type === 'toggle') toggle = true
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) if (typeof value === 'string' && value.length > 0) levels.add(value)
  }
  // A toggle on its own names nothing to choose from — it says the switch exists,
  // not what to set it to — so it is not narrowed to a lone `none`, which would
  // offer "off" and take away the switch the catalog just described.
  if (levels.size === 0) return undefined
  if (toggle) levels.add('none')
  const ordered = REASONING_EFFORTS.map((effort) => effort.id).filter((id) => levels.has(id))
  return ordered.length > 0 ? ordered : undefined
}

/**
 * List the gateway's own catalog ids.
 * @returns the model ids; an empty array when the call fails or returns nothing.
 */
export async function fetchGatewayCatalog({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/models`, { apiKey, signal, timeoutMs })
    const ids = (result.json?.data ?? []).map((model) => model?.id).filter((id) => typeof id === 'string')
    return ids
  } catch {
    return []
  }
}

/**
 * Read the account's official quota consumption.
 *
 * The gateway answers with `{ success, data: { limits: [{ type, percentUsed,
 * resetsAt }] } }`, where `type` is `five_hour`, `weekly` or `monthly`. The
 * window list is passed through in the order the gateway sends it rather than
 * mapped onto a fixed shape here, so a window Cline adds later reaches the panel
 * as an extra row instead of needing a release of this plugin.
 *
 * A refusal is reported as data, never thrown: the panel shows quota beside
 * controls that keep working without it.
 *
 * @returns `{ ok, limits, error }`.
 */
export async function fetchUsageLimits({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  const refusal = { ok: false, limits: [], error: 'the usage endpoint is unavailable' }
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${USAGE_LIMITS_PATH}`, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope) ?? result.text.slice(0, 120)
      return { ...refusal, error: `the usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    // The envelope wrapper is not contractual: read the payload whether the
    // gateway nests it under `data` or answers with the window list itself.
    const payload = envelope?.data ?? envelope
    const limits = (Array.isArray(payload?.limits) ? payload.limits : [])
      .map((limit) => ({
        type: String(limit?.type ?? ''),
        percentUsed: Number(limit?.percentUsed ?? 0),
        resetsAt: String(limit?.resetsAt ?? ''),
      }))
      .filter((limit) => limit.type.length > 0)
    return { ok: true, limits, error: firstMessage(envelope) ?? '' }
  } catch (error) {
    return { ...refusal, error: String(error?.message ?? error) }
  }
}

/** The gateway's own one-line explanation, when it sent one. */
function firstMessage(envelope) {
  const message = envelope?.error ?? envelope?.message ?? envelope?.error?.message
  return typeof message === 'string' ? message.slice(0, 200) : ''
}

/** A `YYYY-MM-DD` day, in UTC, as the daily endpoint expects it. */
function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}


/**
 * One range of per-day usage, from the gateway's own aggregation.
 *
 * One request covers the whole range, which is the only way a complete reading
 * exists at all: the detailed history pages at 200 rows, so a busy account's
 * month cannot be walked row by row — an earlier version tried and stopped at
 * 1200 rows, reporting the same figure for "this week" and "this month".
 *
 * Rows are per day AND per model, so they sum along either axis. The model is
 * kept here rather than flattened away: which models a window's spend went to is
 * the question a quota figure cannot answer, and it is the one that decides where
 * to change behaviour.
 *
 * @returns `{ ok, rows, error }` — `rows` carries `{ date, model, tokens, costUsd }`.
 */
export async function fetchDailyUsage({ baseURL, apiKey, userId, startDate, endDate, signal, timeoutMs = 45000 }) {
  const refusal = { ok: false, rows: [], error: 'the daily usage endpoint is unavailable' }
  try {
    const query = `${trimBase(baseURL)}/users/${encodeURIComponent(userId)}/usages/daily?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    const result = await sendJSON(query, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope)
      return { ...refusal, error: `the daily usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    const payload = envelope?.data ?? envelope
    const rows = (Array.isArray(payload?.items) ? payload.items : []).map((row) => ({
      date: String(row?.date ?? ''),
      // `aiModelName` is the wire spelling; the type name is the fallback so a
      // row still lands somewhere named rather than in an anonymous bucket.
      model: String(row?.aiModelName ?? row?.aiModelTypeName ?? ''),
      tokens: Number(row?.promptTokens ?? 0) + Number(row?.completionTokens ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
    }))
    return { ok: true, rows, error: '' }
  } catch (error) {
    return { ...refusal, error: String(error?.message ?? error) }
  }
}


/**
 * Collect `cline-pass/*` ids from the official endpoints and the community registry.
 *
 * Additive by design: every source that answers contributes, and a source that
 * fails is skipped rather than failing the scan.
 *
 * Metadata is carried, not just ids: a model the plugin has never heard of used
 * to be adopted as an id alone, so it resolved through the fallback to
 * `['text']` and the harness then refused every image for it — a multimodal
 * model that could be selected and chatted with but never shown a picture, and
 * with nothing said about why. `inputModalities` is what the LLM seam's
 * `LlmDiscoveredModel` accepts, so a newly published model arrives knowing what
 * it can read.
 *
 * @returns `{ models, catalog, sources }` — ids, per-model metadata, and the
 *   sources that answered.
 */
export async function fetchOfficialModels({ signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const found = new Map()
  const sources = []
  /** Keep the first metadata a source supplies; both sources are advisory. */
  const add = (value) => {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string') return
    const normalized = id.trim().toLowerCase()
    if (!normalized.startsWith('cline-pass/')) return
    const incoming = typeof value === 'string' ? {} : modelMetadata(value)
    const existing = found.get(normalized)
    found.set(normalized, existing === undefined ? incoming : { ...incoming, ...existing })
  }
  try {
    const response = await fetchImpl(RECOMMENDED_MODELS_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json()
      const list = json?.clinePass ?? json?.data?.clinePass
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(add)
        sources.push('cline.api')
      }
    }
  } catch { /* source unavailable */ }
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json()
      const provider = json?.providers?.['cline-pass'] ?? json?.['cline-pass']
      if (provider?.models !== undefined && provider.models !== null) {
        for (const [id, entry] of Object.entries(provider.models)) {
          add({ ...(entry ?? {}), id: id.startsWith('cline-pass/') ? id : `cline-pass/${id}` })
        }
        sources.push('models.dev')
      }
    }
  } catch { /* source unavailable */ }
  // The upstream's own catalog, matched by the id's tail: `cline-pass/glm-5.3` and
  // `zai/glm-5.3` are the same model reached through the same gateway. It is also
  // the only source that describes a model published after this release — Cline Pass
  // lists ids, names and descriptions, and says nothing about what a model can do,
  // so without this a new model falls back to the route's conservative window.
  //
  // Its output cap is deliberately NOT taken. It disagrees with the published one
  // (32k where the shipped table says 384k) and it moves: the same model reported a
  // different figure a week later. Adopting it would silently resize every request's
  // completion reserve, which is what decides where compaction fires.
  const upstreamByTail = new Map()
  try {
    const response = await fetchImpl(VERCEL_MODELS_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json()
      const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
      for (const row of rows) {
        if (typeof row?.id !== 'string') continue
        // The shared extractor already reads the display name and `modalities.input`,
        // and it deliberately misses this catalog's snake_case output cap — which is
        // exactly the field that must not be adopted.
        const meta = modelMetadata(row)
        const contextWindow = row?.context_window ?? row?.contextWindow
        if (Number.isSafeInteger(contextWindow) && contextWindow > 0) meta.contextWindow = contextWindow
        const efforts = effortsFromOptions(row.reasoning_options)
        if (efforts !== undefined) meta.efforts = efforts
        if (Object.keys(meta).length > 0) upstreamByTail.set(row.id.split('/').pop(), meta)
      }
      if (upstreamByTail.size > 0) sources.push('vercel')
    }
  } catch { /* source unavailable */ }
  const models = [...found.keys()].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id))
  const catalog = {}
  for (const id of models) {
    const meta = found.get(id) ?? {}
    const upstream = upstreamByTail.get(id.slice('cline-pass/'.length))
    if (upstream === undefined) {
      if (Object.keys(meta).length > 0) catalog[id] = meta
      continue
    }
    // Fills what the other sources leave out, so an id list that carries only a name
    // still yields a real window, real levels and real modalities. A source that did
    // describe a field keeps it: this is a gap filler, not an override.
    const entry = { ...upstream, ...meta }
    // The exception is the name, where the id list's "name" is the id itself and
    // says nothing — the upstream publishes the label a person reads.
    if (upstream.name !== undefined && (entry.name === undefined || entry.name === id || entry.name === id.slice('cline-pass/'.length))) {
      entry.name = upstream.name
    }
    catalog[id] = entry
  }
  return { models, catalog, sources }
}

/**
 * Resolve a canonical slug against OpenRouter's public catalog, tolerating the
 * hyphen differences between the gateway's slug and OpenRouter's id.
 * @returns the real OpenRouter id, or null.
 */
export async function resolveOpenRouterSlug(slug, { signal, timeoutMs = 30000 } = {}) {
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models`, { signal, timeoutMs })
    const ids = (result.json?.data ?? []).map((model) => model?.id).filter((id) => typeof id === 'string')
    const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
    return ids.find((id) => id === slug) ?? ids.find((id) => normalize(id) === normalize(slug)) ?? null
  } catch {
    return null
  }
}

/**
 * Per-upstream endpoint detail (context length, recent uptime) for one
 * OpenRouter model. Only meaningful for direct-pipeline models.
 * @returns `{ slug, endpoints }`, where endpoints is `[{ slug, name, endpoints, context, uptime }]`.
 */
export async function openRouterEndpoints(slug, { signal, timeoutMs = 30000 } = {}) {
  const real = await resolveOpenRouterSlug(slug, { signal, timeoutMs })
  if (real === null) return { slug, endpoints: [] }
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models/${real}/endpoints`, { signal, timeoutMs })
    const detail = new Map()
    for (const entry of result.json?.data?.endpoints ?? []) {
      const providerSlug = String(entry?.tag ?? '').split('/')[0] || String(entry?.provider_name ?? '').toLowerCase().replace(/\s+/g, '-')
      if (providerSlug === '') continue
      const current = detail.get(providerSlug) ?? { slug: providerSlug, name: String(entry?.provider_name ?? providerSlug), endpoints: 0, context: 0, uptime: 0 }
      current.endpoints += 1
      current.context = Math.max(current.context, Number(entry?.context_length ?? 0))
      current.uptime = Math.max(current.uptime, Math.round(Number(entry?.uptime_last_30m ?? 0)))
      detail.set(providerSlug, current)
    }
    return { slug: real, endpoints: [...detail.values()] }
  } catch {
    return { slug: real, endpoints: [] }
  }
}
