import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {discoverWikiQueue,runWikiBatch} from './wiki/runner.mjs'
import {WIKI_TOPICS} from './wiki/discovery.mjs'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const [action,...arguments_]=process.argv.slice(2)
const options=Object.fromEntries(arguments_.map(item=>{
 const match=item.match(/^--([a-z-]+)=(.*)$/)
 if(!match)throw Error('Use --name=value arguments only')
 return [match[1],match[2]]
}))
const number=(name,fallback,max)=>{
 const value=options[name]===undefined?fallback:Number(options[name])
 if(!Number.isSafeInteger(value)||value<0||value>max)throw Error(`Invalid --${name}`)
 return value
}
const checkpointBranch=process.env.SAGA_WIKI_CHECKPOINT_BRANCH
const git=(...args)=>execFileSync('git',args,{cwd:base,encoding:'utf8'}).trim()
async function pushCheckpoint(){
 if(!checkpointBranch)return
 if(!/^[-a-zA-Z0-9_/]+$/.test(checkpointBranch)||git('branch','--show-current')!==checkpointBranch)
  throw Error('Checkpoint branch mismatch')
 git('config','user.name','saga-wiki-checkpoint')
 git('config','user.email','saga-wiki-checkpoint@users.noreply.github.com')
 git('add','data/wiki-pipeline-state.json','data/wiki-checkpoints/','public/wiki-reader/')
 if(!git('diff','--cached','--name-only'))return
 git('diff','--cached','--check')
 git('commit','-m','SAGA: save Wikipedia candidate checkpoint')
 git('push','origin',`HEAD:${checkpointBranch}`)
}

try{
 if(action==='discover'){
  const topics=options.topic?[options.topic]:WIKI_TOPICS
  if(topics.some(topic=>!WIKI_TOPICS.includes(topic)))throw Error('Unknown Wiki topic')
  console.log(JSON.stringify(await discoverWikiQueue({base,topics,
   maxPerTopic:number('max-per-topic',20,100),seedLimit:number('seed-limit',1,6),
   subcategoryLimit:number('subcategory-limit',1,4),maxCategoryPages:number('max-category-pages',3,5)})))
 }else if(action==='batch'){
  const maxCalls=number('max-calls',0,20)
  console.log(JSON.stringify(await runWikiBatch({base,maxCalls,maxCandidates:number('max-candidates',5,100),
   pageId:options['page-id']===undefined?null:number('page-id',0,1_000_000_000),
   apiKey:process.env.SAGA_WIKI_GEMINI_KEY||'',freeTierConfirmed:process.env.SAGA_WIKI_FREE_TIER_CONFIRMED==='1',
   model:process.env.SAGA_WIKI_MODEL||'gemini-2.5-flash-lite',
   onPersist:pushCheckpoint})))
 }else throw Error('Usage: node scripts/wiki-pipeline.mjs discover|batch [--max-calls=1] [--max-candidates=5]')
}catch(error){
 console.error(JSON.stringify({status:'stopped',name:error.name||'Error',reason:String(error.message||error).slice(0,180)}))
 process.exitCode=1
}
