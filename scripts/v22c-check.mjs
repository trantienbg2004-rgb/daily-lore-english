import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readFull,fullReadiness,fullEligible} from './v22c-collect.mjs'
export async function checkFull(base=process.cwd(),{strict=false}={}){
 const folder=path.join(base,'public','full-feed')
 const stories=await readFull(base);const status=fullReadiness(stories)
 let manifest={}
 try{manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 const ids=new Set()
 for(const item of stories){if(!fullEligible(item)||ids.has(item.sourceUrl))throw Error('Bad/duplicate full article '+item.sourceUrl);ids.add(item.sourceUrl)}
 const aligned=manifest.total===stories.length&&manifest.sourceCount===status.sourceCount&&manifest.ready===status.ready
 const ready=status.ready&&aligned&&manifest.contentPolicy==='full-only'
 console.log(`V22C CHECK: ${stories.length}/50 full articles; ${status.sourceCount}/3 publishers; READY=${ready}`)
 console.log('SOURCE BREAKDOWN:',JSON.stringify(status.bySource))
 if(strict&&!ready)throw Error('V22C full feed NOT READY: do not switch production. Run ingestion again or inspect public/full-feed/status.json')
 return {ready,status}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))checkFull(process.cwd(),{strict:process.argv.includes('--strict')}).catch(e=>{console.error(e.message);process.exitCode=1})
