/** Account failures must not spend the next account's upstream attempts. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { ClinePassAdapter, streamErrorCode } from '../lib/adapter.js'

let passed = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); passed += 1 }
for (const message of [
  'Weekly limit reached', 'Your weekly usage limit has been exceeded',
  'weekly quota exhausted', 'weekly window exhausted',
  'You have reached your weekly limit', 'You exceeded your weekly cap',
  'five_hour usage limit exceeded', 'five-hour window exhausted',
  '5_hour limit reached', 'monthly allowance used up',
  'daily budget depleted', 'Plan limit reached',
  'weekly_limit_exceeded', 'Out of weekly credits',
]) check(streamErrorCode(message, 429), QUOTA_EXCEEDED_CODE, message)
check(streamErrorCode('Payment required', 402), QUOTA_EXCEEDED_CODE, 'HTTP 402')
for (const message of ['429 Too Many Requests', 'rate limit exceeded', 'temporarily rate limited']) {
  check(streamErrorCode(message, 429), 'RATE_LIMIT', message)
}
check(streamErrorCode('invalid api key', 401), 'AUTH', 'authentication still classified')
check(streamErrorCode('weekly usage endpoint temporarily unavailable', 503), 'SERVER', 'window name alone is not exhaustion')

const requests = []
let refusal = { status: 429, message: 'Weekly limit reached', sse: false, partial: false }
let refuseAll = false
let rejectFirstPin = false
const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const account = request.headers.authorization?.replace('Bearer ', '')
  const pin = body.providerOptions?.gateway?.only?.[0] ?? body.provider?.only?.[0] ?? null
  requests.push({ account, pin })
  const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`)
  if (account === 'spent' || refuseAll) {
    if (!refusal.sse) {
      response.writeHead(refusal.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: refusal.message } }))
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (refusal.partial) frame({ choices: [{ delta: { content: 'partial' } }] })
      frame({ error: { message: refusal.message } })
      response.end('data: [DONE]\n\n')
    }
    return
  }
  if (rejectFirstPin && pin === 'a') {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'upstream a refused the pin' }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  frame({ choices: [{ delta: { content: 'backup answered' } }] })
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  response.end('data: [DONE]\n\n')
})
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${gateway.address().port}/api/v1`
const records = []
const makeAdapter = (upstreams = []) => new ClinePassAdapter({
  connection: () => ({ maxTokens: 1024, streamIdleTimeoutMs: 3000 }),
  modelMeta: () => ({ pipeline: 'planner' }),
  pin: () => ({ upstreams, pinMode: 'strict' }),
  resolveAccount: async ({ exclude }) => {
    const name = ['spent', 'backup'].find((name) => !exclude.includes(name))
    return name === undefined ? undefined : { name, key: name, baseURL }
  },
  record: (model, info) => records.push({ model, ...info }),
  learnUpstream: () => {},
})
const run = async (upstreams) => {
  requests.length = records.length = 0
  const chunks = []
  for await (const chunk of makeAdapter(upstreams).stream({
    model: 'cline-pass/test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)
  return chunks
}
try {
  for (const upstreams of [[], ['a'], ['a', 'b']]) {
    const chunks = await run(upstreams)
    check(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'backup answered'), true, 'backup serves the same request')
    check(requests, [{ account: 'spent', pin: upstreams[0] ?? null }, { account: 'backup', pin: upstreams[0] ?? null }], 'account refusal retries the original pin')
    check(records[0]?.code, QUOTA_EXCEEDED_CODE, 'spent account records quota code')
    check(records[0]?.account, 'spent', 'refusal names the spent account')
    check(records.at(-1)?.account, 'backup', 'success names the backup account')
  }
  rejectFirstPin = true
  await run(['a', 'b'])
  check(requests, [{ account: 'spent', pin: 'a' }, { account: 'backup', pin: 'a' }, { account: 'backup', pin: 'b' }], 'backup retains its full channel chain')
  rejectFirstPin = false
  for (const variant of [
    { status: 402, message: 'Payment required' },
    { status: 401, message: 'invalid api key' },
    { sse: true, message: 'five_hour window exhausted' },
  ]) {
    refusal = variant
    await run([])
    check(requests.map((row) => row.account), ['spent', 'backup'], 'HTTP and SSE account failures both fail over')
  }
  refuseAll = true
  await assert.rejects(run([]), { code: QUOTA_EXCEEDED_CODE })
  passed += 1
  check(requests.map((row) => row.account), ['spent', 'backup'], 'every exhausted account tried once; retry terminates')
  refuseAll = false
  refusal = { status: 429, message: '429 Too Many Requests' }
  await assert.rejects(run(['a', 'b']), { code: 'RATE_LIMIT' })
  passed += 1
  check(requests, [{ account: 'spent', pin: 'a' }, { account: 'spent', pin: 'b' }], 'transient rate limit keeps channel retry without refusing the account')
  refusal = { sse: true, partial: true, message: 'weekly limit reached' }
  await assert.rejects(run([]), { code: QUOTA_EXCEEDED_CODE })
  passed += 1
  check(requests.map((row) => row.account), ['spent'], 'no failover after content has reached the caller')
} finally {
  gateway.closeAllConnections()
  await new Promise((resolve) => gateway.close(resolve))
}
console.log(`✔ all ${passed} account failover checks passed`)
