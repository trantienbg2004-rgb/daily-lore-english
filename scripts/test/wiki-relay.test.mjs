import test from 'node:test'
import assert from 'node:assert/strict'
import { nextDelay, newerRunExists, relayNextRun } from '../wiki/relay.mjs'

const current = { id: 100, created_at: '2026-10-24T00:00:00Z' }
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

test('Wiki relay waits for the bounded interval and dispatches one 20-call run', async () => {
  const calls = []
  const waits = []
  const result = await relayNextRun({
    repository: 'owner/repo', runId: 100, token: 'test-token',
    now: () => Date.parse('2026-10-24T00:08:00Z'),
    sleep: async ms => waits.push(ms), log: () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/actions/runs/100')) return response(current)
      if (url.includes('/runs?')) return response({ workflow_runs: [current] })
      return response(null, 204)
    },
  })
  assert.deepEqual(result, { dispatched: true })
  assert.deepEqual(waits, [17 * 60 * 1000])
  assert.equal(calls.length, 3)
  assert.equal(calls[2].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    ref: 'main', inputs: { max_calls: '20', relay: 'on' },
  })
})

test('Wiki relay yields to a newer run instead of starting a second chain', async () => {
  const calls = []
  const result = await relayNextRun({
    repository: 'owner/repo', runId: 100, token: 'test-token',
    now: () => Date.parse('2026-10-24T00:26:00Z'), log: () => {},
    fetchImpl: async url => {
      calls.push(url)
      if (url.endsWith('/actions/runs/100')) return response(current)
      return response({ workflow_runs: [
        { id: 101, created_at: '2026-10-24T00:12:00Z' }, current,
      ] })
    },
  })
  assert.deepEqual(result, { dispatched: false })
  assert.equal(calls.length, 2)
})

test('Wiki relay stops on API error; the backup cron can recover later', async () => {
  await assert.rejects(relayNextRun({
    repository: 'owner/repo', runId: 100, token: 'test-token',
    fetchImpl: async () => response(null, 403),
  }), /HTTP 403/)
})

test('Wiki relay rejects invalid clock and recognizes later same-second run IDs', () => {
  assert.throws(() => nextDelay('bad', Date.now()), /clock/)
  assert.equal(newerRunExists([{ id: 101, created_at: current.created_at }], current), true)
})
