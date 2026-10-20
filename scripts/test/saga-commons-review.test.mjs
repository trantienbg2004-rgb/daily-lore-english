import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {approvedCommonsPhoto,commonsQueryFor,reviewCommonsPhoto} from '../discover/commonsMedia.mjs'

const bytes=Buffer.from('inspected image fixture')
const sha256=createHash('sha256').update(bytes).digest('hex')
const sourceUrl='https://globalvoices.org/2026/10/16/lula-hoax'
const imagePageUrl='https://commons.wikimedia.org/wiki/File:Luiz_Inacio_Lula_da_Silva.jpg'
const imageUrl='https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/Luiz_Inacio_Lula_da_Silva.jpg'
const licence='https://creativecommons.org/licenses/by/2.0/'
const imagePage=(title='Luiz Inacio Lula da Silva')=>({title:'File:'+title+'.jpg',imageinfo:[{
 mime:'image/jpeg',width:960,height:1200,thumburl:imageUrl,descriptionurl:imagePageUrl,
 extmetadata:{LicenseUrl:{value:licence},LicenseShortName:{value:'CC BY 2.0'},Artist:{value:'Ricardo Stuckert/PR'},
  DateTimeOriginal:{value:'2023-02-16'},ImageDescription:{value:'Official portrait of Lula'}}}]})
const pageTexts=['Lula faced a false claim in Brazil.','Lula was targeted by an online hoax.','An online network distorted a statement by Lula.']
const article={sourceUrl,title:'An online hoax about Lula',pageIndex:0,pageTexts}
const review={sourceUrl,imagePageUrl,imageUrl,licenseUrl:licence,sha256,pageIndex:0,
 pageTextSha256:createHash('sha256').update(pageTexts.join('\n')).digest('hex'),
 method:'human-visual-inspection',reviewer:'SAGA editorial review',reviewedAt:'2026-10-19',
 visual:{subjectProminent:true,visibleSubjects:['Lula'],observation:'An identifiable official portrait of Lula occupies most of the frame.'},
 subject:'Lula',identityEvidenceUrl:'https://commons.wikimedia.org/wiki/File:Luiz_Inacio_Lula_da_Silva.jpg',
 kind:'archive',imageDate:'2023-02-16',
 caption:'Archive portrait of Lula, photographed in 2023; it does not show the 2026 hoax.'}
const candidate=()=>approvedCommonsPhoto(imagePage(),'Luiz Inacio Lula da Silva')
const result=(changes={},articleChanges={},photo=candidate(),image=bytes)=>
 reviewCommonsPhoto(photo,{...article,...articleChanges},{...review,...changes},image)

test('Commons filename and CC licence only produce an unverified candidate',()=>{
 assert.equal(candidate()?.verified,false)
 assert.equal(candidate()?.metadata.capturedAt,'2023-02-16')
 assert.equal(commonsQueryFor('Chabacano poetry book in Zamboanga'),'')
 assert.equal(commonsQueryFor('Lansing local election'),'')
 assert.equal(commonsQueryFor('Little penguins vaccinated in Australia'),'Australian little penguin')
})
test('a visible, licensed archival portrait matches all three first pages when labelled honestly',()=>{
 const accepted=result()
 assert.equal(accepted.reason,'')
 assert.equal(accepted.photo.verified,true)
 assert.equal(accepted.photo.provenance.visualReview.sha256,sha256)
 assert.match(accepted.photo.caption,/Archive portrait/)
})
test('Little Penguin file with an imperceptible bird fails visual prominence despite its correct name',()=>{
 // Observed in the real Commons file Little_penguin_.jpg: the bird is a tiny
 // speck within a wide water view at the size used by SAGA Reader.
 assert.equal(result({visual:{...review.visual,subjectProminent:false,
  observation:'A tiny dark speck in a broad water view is not discernible as a penguin at reader size.'}}).reason,
  'visual-subject-unverified')
})
test('right person in an older photo cannot masquerade as the reported event',()=>{
 assert.equal(result({kind:'archive',caption:'Lula at the reported event',imageDate:'2023-02-16'}).reason,
  'archive-not-clearly-labelled')
 assert.equal(result({kind:'event',imageDate:'2023-02-16',imagePlace:'Brasilia',
  eventEvidenceUrl:'https://example.org/event'},{eventDate:'2026-10-16',eventPlace:'Rio de Janeiro'}).reason,
  'event-place-or-time-unverified')
})
test('a correctly named place or subject without visible identity is rejected',()=>{
 assert.equal(result({visual:{...review.visual,visibleSubjects:['city building']}}).reason,
  'visible-subject-mismatch')
 assert.equal(result({subject:'Lula'},{pageTexts:[pageTexts[0],'Another page about a different person.',pageTexts[2]]}).reason,
  'article-page-changed')
})
test('wrong event, location, or date is rejected before publication',()=>{
 const event={kind:'event',imageDate:'2026-10-16',imagePlace:'Brasilia',
  eventEvidenceUrl:'https://example.org/event'}
 assert.equal(result(event,{eventDate:'2026-10-16',eventPlace:'Rio de Janeiro'}).reason,
  'event-place-or-time-unverified')
 assert.equal(result({...event,imageDate:'2025-10-16'},{eventDate:'2026-10-16',eventPlace:'Brasilia'}).reason,
  'event-place-or-time-unverified')
 assert.equal(result({...event,imagePlace:'Rio de Janeiro',eventEvidenceUrl:''},
  {eventDate:'2026-10-16',eventPlace:'Rio de Janeiro'}).reason,'event-place-or-time-unverified')
})
test('charts and maps require the same stated data period and a data source',()=>{
 assert.equal(result({kind:'data',dataPeriod:'2022',dataSourceUrl:'https://example.org/data'},
  {dataPeriod:'2026'}).reason,'data-period-unverified')
 assert.equal(result({kind:'data',dataPeriod:'2026',dataSourceUrl:''},
  {dataPeriod:'2026'}).reason,'data-period-unverified')
})
test('relevant but restricted images and changed bytes are rejected',()=>{
 const noRights=structuredClone(candidate())
 noRights.provenance.licenseUrl='https://creativecommons.org/licenses/by-nc/4.0/'
 assert.equal(result({}, {}, noRights).reason,'unlicensed-or-unreviewed-candidate')
 assert.equal(result({}, {}, candidate(),Buffer.from('different image')).reason,'image-or-license-changed')
 assert.equal(result({imageUrl:'https://example.org/other.jpg'}).reason,'image-or-license-changed')
})
