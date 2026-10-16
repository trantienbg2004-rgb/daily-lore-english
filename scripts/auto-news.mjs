import { runDiscoverPublication } from './discover-publish.mjs'

const key = process.env.GEMINI_API_KEY

if (!key) {
  console.error('GEMINI_API_KEY missing. No publication performed.')
  process.exit(1)
}

try {
  const result = await runDiscoverPublication({
    apiKey: key,
    now: new Date(),
    log: console
  })

  console.log('SAGA AUTO NEWS RESULT:', JSON.stringify(result))

  if (!result.published) {
    console.log('No eligible new stories. Existing catalog preserved.')
  }
} catch (error) {
  console.error('SAGA AUTO NEWS FAILED:', error)
  process.exitCode = 1
}