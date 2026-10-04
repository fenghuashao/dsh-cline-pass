/** Account edits shared by the panel and management tools. */

/** Allocate a stable reference without folding distinct account names together. */
function credentialName(name, accounts) {
  const stem = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const base = `CLINE_PASS_${stem}_KEY`
  const used = new Set(Object.entries(accounts).filter(([key]) => key !== name).map(([, entry]) => String(entry?.apiKeyEnv ?? '')))
  // Keep the familiar name for simple lowercase ids. Other ids carry their
  // exact bytes, so case and punctuation remain distinct even on concurrent adds.
  const encoded = `${base}__${Buffer.from(name).toString('hex').toUpperCase()}`
  let ref = /^[a-z0-9_]+$/.test(name) && !used.has(base) ? base : encoded
  for (let suffix = 2; used.has(ref); suffix += 1) ref = `${encoded}_${suffix}`
  return ref
}

/** Apply only supplied fields when updating; allocate defaults on creation. */
export function accountProfileFor(name, changes, accounts, defaultRef = '') {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '__proto__') {
    throw new Error('the account name may use letters, digits, dot, dash and underscore only (except __proto__)')
  }
  const existing = Object.hasOwn(accounts, name) ? accounts[name] : undefined
  const previous = existing ?? {}
  const suppliedRef = String(changes?.apiKeyEnv ?? '').trim()
  const priorRef = String(previous.apiKeyEnv ?? '').trim() || (existing === undefined ? '' : String(defaultRef))
  return {
    displayName: changes?.displayName === undefined ? (String(previous.displayName ?? '') || name) : (String(changes.displayName).trim() || name),
    apiKeyEnv: suppliedRef || priorRef || credentialName(name, accounts),
    enabled: changes?.enabled === undefined ? previous.enabled !== false : changes.enabled !== false,
    baseURL: changes?.baseURL === undefined ? String(previous.baseURL ?? '') : String(changes.baseURL ?? '').trim(),
  }
}
