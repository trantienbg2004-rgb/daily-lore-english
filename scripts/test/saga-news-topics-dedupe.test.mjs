import test from 'node:test'
import assert from 'node:assert/strict'
import {NEWS_TOPICS,classifyNewsTopic} from '../discover/topics.mjs'
import {storyRelationship} from '../discover/dedupe.mjs'
import {buildThreeLevelRequest} from '../discover/geminiLevels.mjs'

test('news taxonomy has exactly ten controlled labels and covers all subject families',()=>{
 assert.equal(NEWS_TOPICS.length,10)
 assert.equal(new Set(NEWS_TOPICS).size,10)
 const examples={
  'Politics':'Election reform changes parliament in Ghana',
  'Economy':'International trade tariffs affect Asian markets',
  'Conflict & Security':'Border war displaces families in Sudan',
  'Society':'Families rebuild community after migration',
  'Culture':'Poetry book keeps Chabacano language alive',
  'Science & Technology':'New satellite technology helps researchers',
  'Environment':'Amazon wildfires threaten rainforest communities',
  'Health':'New vaccine helps prevent bird flu',
  'History & Geography':'Ancient maps reveal island geography',
  'Sports':'Olympic athletes prepare for tournament'
 }
 for(const [topic,title] of Object.entries(examples))assert.equal(classifyNewsTopic({title}),topic,title)
})

test('same event and angle is blocked while another material angle proceeds',()=>{
 const old={sourceUrl:'https://globalvoices.org/story-a',title:'India Bangladesh border election changes diplomatic talks',category:'Politics',publishedAt:'2026-10-18T00:00:00Z',text:'The two governments held a meeting about the election and border talks.'}
 const copy={sourceUrl:'https://example.org/story-b',title:'India Bangladesh border election changes diplomatic talks',topic:'Politics',publishedAt:'2026-10-19T00:00:00Z',text:'The two governments held a meeting about the election and border talks.'}
 const angle={sourceUrl:'https://example.org/story-c',title:'India Bangladesh border trade costs trouble farmers',topic:'Economy',publishedAt:'2026-10-19T00:00:00Z',text:'Farmers describe costs and lost trade after border disruption.'}
 assert.equal(storyRelationship(copy,old),'duplicate')
 assert.equal(storyRelationship(angle,old),'different-angle')
 const request=buildThreeLevelRequest({...angle,sourceName:'Example',priorAngle:{title:old.title,topic:old.category,summary:old.text}})
 const task=JSON.parse(request.contents[0].parts[0].text)
 assert.equal(task.previousPublishedAngle.title,old.title)
 assert.match(task.angleInstruction,/only source of facts/)
})
