import { pathToFileURL } from 'node:url'

const WORKFLOW = 'saga-wiki-publish.yml'
const INTERVAL_MS = 25 * 60 * 1000
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'saga-wiki-relay',
}

export function nextDelay(createdAt, now, intervalMs = INTERVAL_MS) {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created) || !Number.isFinite(now) || intervalMs < 60_000) {
    throw new Error('Invalid Wiki relay clock')
  }
  return Math.max(0, created + intervalMs - now)
}

export function newerRunExists(runs, current) {
  const started = Date.parse(current.created_at)
  return runs.some(run => run.id !== current.id &&
    (Date.parse(run.created_at) > started ||
      (Date.parse(run.created_at) === started && run.id > current.id)))
}

export async function relayNextRun({
  repository, runId, token, fetchImpl = fetch, now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+$/.test(String(runId)) || !token) {
    throw new Error('Wiki relay needs a repository, run ID and job token')
  }
  const base = `https://api.github.com/repos/${repository}`
  const headers = { ...API_HEADERS, authorization: `Bearer ${token}` }
  const request = async (path, init = {}) => {
    const response = await fetchImpl(base + path, { ...init, headers: { ...headers, ...init.headers } })
    if (!response.ok) throw new Error(`Wiki relay GitHub API HTTP ${response.status}`)
    return response
  }
  const current = await (await request(`/actions/runs/${runId}`)).json()
  if (String(current.id) !== String(runId)) throw new Error('Wiki relay run ID changed')
  const delay = nextDelay(current.created_at, now())
  if (delay) {
    log(`Wiki relay waiting ${Math.ceil(delay / 1000)} seconds`)
    await sleep(delay)
  }
  const listing = await (await request(`/actions/workflows/${WORKFLOW}/runs?per_page=20`)).json()
  if (!Array.isArray(listing.workflow_runs)) throw new Error('Wiki relay run list unavailable')
  if (newerRunExists(listing.workflow_runs, current)) {
    log('Wiki relay skipped: a newer collection run exists')
    return { dispatched: false }
  }
  await request(`/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { max_calls: '20', relay: 'on' } }),
  })
  log('Wiki relay dispatched the next bounded collection run')
  return { dispatched: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  relayNextRun({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GH_TOKEN,
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
