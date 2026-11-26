// Research only. Never imported by production publishing code.
import fs from 'node:fs'
import {profileTextCEFR,loadCEFRWordlist,loadLemmaMap} from './wiki/cefrProfiler.mjs'

export function parseWikiAuto(text){
 const rows=[]
 const seen=new Set()
 for(const line of text.split(/\r?\n/)){
  const [sentence,a,b,...rest]=line.split('\t')
  if(rest.length||!sentence?.trim()||! /^[1-6]$/.test(a)||a!==b)continue
  const key=sentence.toLowerCase().replace(/\s+/g,' ').trim()
  if(seen.has(key))continue
  seen.add(key);rows.push({sentence,key,label:Number(a)})
 }
 return rows
}
export const features=p=>[p.fkgl,p.avgSentenceLength,p.wordCount?p.syllableCount/p.wordCount:0,
 p.lexicalProfile.a1a2Pct,p.lexicalProfile.a1ToB2Pct,p.lexicalProfile.c1Pct+p.lexicalProfile.c2Pct,
 p.lexicalProfile.unlistedPct]
const sigmoid=x=>1/(1+Math.exp(-Math.max(-40,Math.min(40,x))))
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0)
export function train(rows,ceiling){
 const n=rows.length,d=rows[0].x.length
 const mean=Array.from({length:d},(_,i)=>rows.reduce((s,r)=>s+r.x[i],0)/n)
 const sd=mean.map((m,i)=>Math.sqrt(rows.reduce((s,r)=>s+(r.x[i]-m)**2,0)/n)||1)
 const data=rows.map(r=>({x:[1,...r.x.map((v,i)=>(v-mean[i])/sd[i])],y:Number(r.label>ceiling)}))
 const pos=data.filter(r=>r.y).length,neg=n-pos
 if(!pos||!neg)throw Error('Both classes required')
 const w=Array(d+1).fill(0)
 for(let epoch=0;epoch<500;epoch++){
  const grad=Array(d+1).fill(0)
  for(const r of data){
   const err=(sigmoid(dot(w,r.x))-r.y)*n/(2*(r.y?pos:neg))
   r.x.forEach((v,i)=>grad[i]+=err*v)
  }
  for(let i=0;i<w.length;i++)w[i]-=.1*(grad[i]/n+(i?.01*w[i]:0))
 }
 return {mean,sd,w,ceiling}
}
export function score(model,x){
 return sigmoid(dot(model.w,[1,...x.map((v,i)=>(v-model.mean[i])/model.sd[i])]))
}
export function metrics(rows,ceiling,predict){
 let tp=0,fp=0,tn=0,fn=0
 for(const r of rows){
  const hard=r.label>ceiling,flag=predict(r)
  if(hard&&flag)tp++;else if(hard)fn++;else if(flag)fp++;else tn++
 }
 return {tp,fp,tn,fn,missedHardRate:fn/(tp+fn),falseWarningRate:fp/(fp+tn),balancedAccuracy:(tp/(tp+fn)+tn/(tn+fp))/2}
}
// Ordinal research classifier: estimate five cumulative boundaries, enforce monotonicity.
export function predictSixLevels(models,x){
 const probabilities=models.map(m=>score(m,x))
 for(let i=1;i<probabilities.length;i++)probabilities[i]=Math.min(probabilities[i],probabilities[i-1])
 return 1+probabilities.filter(v=>v>=.5).length
}
export function evaluateSixLevels(training,held){
 const models=[1,2,3,4,5].map(n=>train(training,n))
 const confusion=Array.from({length:6},()=>Array(6).fill(0))
 const band=n=>Math.ceil(n/2)
 let exact=0,groupCorrect=0,withinOne=0,under=0,over=0
 for(const r of held){
  const p=predictSixLevels(models,r.x)
  confusion[r.label-1][p-1]++
  exact+=Number(p===r.label)
  groupCorrect+=Number(band(p)===band(r.label))
  withinOne+=Number(Math.abs(p-r.label)<=1)
  under+=Number(band(p)<band(r.label))
  over+=Number(band(p)>band(r.label))
 }
 return {n:held.length,confusion,exact,groupCorrect,withinOne,under,over,
  boundaries:models.map(m=>({above:m.ceiling,...metrics(held,m.ceiling,r=>score(m,r.x)>=.5)}))}
}
export function experiment(trainText,devText,opts={}){
 const wordlist=opts.wordlist||loadCEFRWordlist(),lemmaMap=opts.lemmaMap||loadLemmaMap()
 const training=parseWikiAuto(trainText),keys=new Set(training.map(r=>r.key))
 const held=parseWikiAuto(devText).filter(r=>!keys.has(r.key))
 const prep=rows=>rows.map(r=>({...r,x:features(profileTextCEFR(r.sentence,{wordlist,lemmaMap}))}))
 const tr=prep(training),dev=prep(held)
 const counts=rows=>Array.from({length:6},(_,i)=>rows.filter(r=>r.label===i+1).length)
 return {train:tr.length,dev:dev.length,trainCounts:counts(tr),devCounts:counts(dev),
  sixLevels:evaluateSixLevels(tr,dev),
  results:[2,4].map(ceiling=>{
   const model=train(tr,ceiling)
   return {ceiling,baseline:metrics(dev,ceiling,r=>r.x[0]>(ceiling===2?6.8:10.8)),
    model:metrics(dev,ceiling,r=>score(model,r.x)>=.5)}
  })}
}
if(process.argv[1]?.endsWith('cefr-shadow-experiment.mjs')){
 if(process.argv.length!==4)throw Error('Usage: node scripts/cefr-shadow-experiment.mjs TRAIN.txt DEV.txt')
 console.log(JSON.stringify(experiment(fs.readFileSync(process.argv[2],'utf8'),fs.readFileSync(process.argv[3],'utf8')),null,2))
}
