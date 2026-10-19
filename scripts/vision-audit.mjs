/** One bounded, read-only validation run on four previously hand-reviewed
 * Commons thumbnails. No publication path imports this file. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {approvedCommonsPhoto} from './discover/commonsMedia.mjs'
import {screenCommonsVisual} from './discover/commonsVision.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const reportDir=path.join(root,'reports','saga-discover-local','vision-audit')
const levels=['A1-A2','B1-B2','C1-C2']
const samples=[
 {id:'little-penguin',sourceUrl:'https://globalvoices.org/2026/08/26/thousands-of-little-penguins-will-be-vaccinated-against-bird-flu-down-under',subject:'penguin',query:'Australian little penguin',
  file:'File:Little_penguin_.jpg',sha256:'4451daf6465abef192d893979a8445a3784334f3b056b97a31dc5daf0632c20a',manual:'reject: bird is imperceptible at Reader size'},
 {id:'lula-archive',sourceUrl:'https://globalvoices.org/2026/10/16/how-an-extremist-network-articulated-a-hoax-linking-brazils-president-lula-to-child-abuse-on-x',subject:'Lula',query:'Luiz Inacio Lula da Silva',
  file:decodeURIComponent('File:Foto_oficial_de_Luiz_In%C3%A1cio_Lula_da_Silva_(ombros).jpg'),sha256:'35cb26bee96aff5fb8073edd38c83e6886f2a1a798106ff0af792848fa19c1cc',manual:'accept as labelled 2023 archival portrait only'},
 {id:'falcon-wrong-event',sourceUrl:'https://globalvoices.org/2026/09/14/nest-flix-peregrine-falcons-become-streaming-stars-of-the-34th-floor-in-australia',subject:'falcon',query:'Australian peregrine falcon',
  file:'File:Peregrine_falcon_(Falco_peregrinus)_in_flight,_Cape_Baily,_Kamay_Botany_Bay_NSW_Jun_2022.jpg',sha256:'79511e140cd74b2e32ef54b9237252cb56b97367c26b374bc18a13c64c440ff3',manual:'reject: 2022 New South Wales photo, not Melbourne nest'},
 {id:'tharu-wrong-community',sourceUrl:'https://globalvoices.org/2026/08/21/the-everyday-guardians-rana-tharu-womens-implicit-roles-in-nepal',subject:'Tharu',query:'Tharu Nepal',
  file:'File:Tharu_Community_in_Kapilbastu,_Nepal_06.JPG',sha256:'fd45b24a6302924256df20a7eea70a847b4d5ed7a7fe6e9d9ec09d046e02bbfc',manual:'reject: Kapilbastu photo does not establish Rana Tharu subgroup'}]

async function fetchCapped(url,maxBytes){
 const response=await fetch(url,{headers:{'User-Agent':'SAGA/0.1 (https://saga.id.vn; licensed visual audit)'},signal:AbortSignal.timeout(15000)})
 if(!response.ok||Number(response.headers.get('content-length')||0)>maxBytes)throw Error('image-audit-source-unavailable')
 const bytes=Buffer.from(await response.arrayBuffer())
 if(bytes.length<100||bytes.length>maxBytes)throw Error('image-audit-size-invalid')
 return bytes
}

async function loadSample(sample,index){
 const catalog=JSON.parse(await fs.readFile(path.join(root,'public','lore-reader','catalog-index.json'),'utf8'))
 const entry=catalog.entries.find(item=>item.id===sample.sourceUrl)
 if(!entry)throw Error(`sample-${index}-not-in-catalog`)
 const shard=JSON.parse(await fs.readFile(path.join(root,'public','lore-reader',`${entry.shard}.json`),'utf8'))
 const story=shard.find(item=>item.sourceUrl===sample.sourceUrl&&item.contentType==='news')
 if(!story)throw Error(`sample-${index}-missing-shard-story`)
 const article={sourceUrl:sample.sourceUrl,title:story.title,pageIndex:0,
  pageTexts:levels.map(level=>story.levelVariants[level].pages[0].text)}
 const api=new URL('https://commons.wikimedia.org/w/api.php')
 for(const [key,value] of Object.entries({action:'query',titles:sample.file,prop:'imageinfo',
  iiprop:'url|size|mime|extmetadata',iiurlwidth:'800',format:'json'}))api.searchParams.set(key,value)
 const page=Object.values(JSON.parse((await fetchCapped(api.href,1_000_000)).toString()).query?.pages||{})[0]
 const candidate=approvedCommonsPhoto(page,sample.query)
 if(!candidate)throw Error(`sample-${index}-rights-or-metadata-changed`)
 const imageBytes=await fetchCapped(candidate.url,5_000_000)
 if(createHash('sha256').update(imageBytes).digest('hex')!==sample.sha256)
  throw Error(`sample-${index}-image-changed`)
 return {candidate,article,imageBytes}
}

async function main(){
 const preflight=process.argv.includes('--preflight')
 if(!preflight&&(process.env.SAGA_VISION_FREE_TIER_CONFIRMED!=='yes'||!process.env.GEMINI_API_KEY))
  throw Error('Free-tier project or secret not confirmed; zero Gemini calls')
 const budget={remaining:Math.min(4,samples.length)},rows=[]
 await fs.mkdir(reportDir,{recursive:true})
 for(const [index,sample] of samples.entries()){
  const {candidate,article,imageBytes}=await loadSample(sample,index)
  if(preflight){rows.push({id:sample.id,source:'same manually reviewed 800px bytes',sha256:sample.sha256,manual:sample.manual});continue}
  if(index>0)await delay(16_000)
  const result=await screenCommonsVisual({candidate,article,subject:sample.subject,imageBytes,
   apiKey:process.env.GEMINI_API_KEY,freeTierConfirmed:true,budget,cacheDir:reportDir})
  rows.push({id:sample.id,sha256:sample.sha256,manual:sample.manual,modelStatus:result.status,
   reason:result.reason,observation:result.observation||null,usage:result.usage||{},cached:!!result.cached})
  await fs.writeFile(path.join(reportDir,'results.json'),JSON.stringify({model:'gemini-2.5-flash',rows},null,2)+'\n')
  console.log(JSON.stringify({sample:sample.id,status:result.status,reason:result.reason,
   totalTokens:result.usage?.totalTokenCount??null}))
  if(result.status==='unavailable')break // 429, 503, malformed output or uncertainty: no retries.
 }
 const used=samples.length-budget.remaining
 const totalTokens=rows.reduce((sum,row)=>sum+(row.usage?.totalTokenCount||0),0)
 if(preflight)console.log(JSON.stringify({preflight:true,matched:rows.length,geminiCalls:0}))
 else console.log(JSON.stringify({geminiCalls:used,totalTokens,completed:rows.length,
  stopped:rows.some(row=>row.modelStatus==='unavailable')}))
}

main().catch(error=>{console.error('SAGA VISION AUDIT BLOCKED:',error.message);process.exitCode=1})
