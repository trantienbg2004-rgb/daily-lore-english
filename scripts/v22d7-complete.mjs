/** One command to finish the V22-D7 news pipeline locally: broaden licensed
 * independent reporting, then build the guarded long-form reader. Failures
 * in a remote source never delete a previous publishable reader release.
 */
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {collectMoreGlobalVoices} from './v22d7-collect-globalvoices.mjs'
import {buildWorldReader} from './v22d7-build-reader.mjs'
export async function completeWorldReader(opts={}){
 const base=opts.base||process.cwd(),log=opts.log||console,now=opts.now||new Date()
 let collected={added:0,checked:0,feedErrors:{}}
 if(!opts.offline){
  try {collected=await collectMoreGlobalVoices({...opts,base,now,log})}
  catch(e){log.warn?.(`Independent source temporarily unavailable: ${String(e.message||e)}. Reusing the verified pilot.`)}
 }
 const built=await buildWorldReader({base,now})
 log.log(`DAILY NEWS RESULT: staged checked, ${collected.added} independent full stories added, ${built.items.length} publishable stories, readerReady=${built.manifest.ready}`)
 return {collected,built}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 completeWorldReader({offline:process.argv.includes('--offline')}).then(({built})=>{if(!built.manifest.ready)process.exitCode=2})
  .catch(e=>{console.error('V22-D7 ERROR:',e.message);process.exitCode=1})
}
