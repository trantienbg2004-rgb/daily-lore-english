import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const read=p=>fs.readFile(path.join(root,p),'utf8')
const exists=p=>fs.access(path.join(root,p)).then(()=>true,()=>false)
test('Legacy lore publisher is archived while files remain available for recovery',async()=>{
 const workflow=await read('.github/workflows/daily-lore-library.yml')
 assert.doesNotMatch(workflow,/cron:/)
 assert.match(workflow,/if: false/)
 assert.match(workflow,/node scripts\/lore-collect\.mjs --limit=80/)
 assert.match(workflow,/git add public\/lore-reader reports\/DAILY_LORE_SOURCE_STATE\.json/)
 assert.match(workflow,/concurrency:/)
 assert.match(workflow,/node scripts\/lore-verify\.mjs/)
 for(const old of ['daily-stories.yml','daily-world-reader.yml','v22a-newsroom.yml']){
  assert.equal(await exists('.github/workflows/'+old),false,'old schedule is no longer active: '+old)
  assert.equal(await exists('.github/legacy-workflows/'+old),true,'old workflow is preserved for recovery: '+old)
 }
})
test('Original article action has a compact Source control above it; full attributions remain accessible',async()=>{
 const app=await read('src/App.jsx')
 const first=app.indexOf('className="story-end-attribution"')
 assert.equal(first,-1,'source attribution retains styling along existing button class')
 const attribution=app.indexOf('className="story-end-credits story-end-attribution"')
 const original=app.indexOf('className="story-end-cta"')
 assert.ok(attribution>0 && original>attribution,'Source control must be above original-article link')
 assert.match(app,/>Source<\/button>/)
 assert.doesNotMatch(app,/>Sources &amp; credits<\/button>/)
 assert.match(app,/setShowCredits\(true\)/)
 assert.match(app,/<strong>Text license:<\/strong>/)
 assert.match(app,/Image attributions/)
 assert.match(app,/Image license ↗/)
 assert.match(app,/words.*setWords/s)
})
