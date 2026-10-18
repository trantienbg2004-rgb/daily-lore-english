export const NEWS_TOPICS=Object.freeze([
 'Politics','Economy','Conflict & Security','Society','Culture',
 'Science & Technology','Environment','Health','History & Geography','Sports'
])

const RULES=[
 ['Sports',/\b(?:sport\w*|football|soccer|basketball|cricket|olympic\w*|athlet\w*|tournament|world cup|match|team|league)\b/i],
 ['History & Geography',/\b(?:histor\w*|archaeolog\w*|heritage|ancient|centur\w*|historical map|geograph\w*|cartograph\w*)\b/i],
 ['Culture',/\b(?:poetr\w*|poem\w*|book\w*|literatur\w*|language\w*|music\w*|musician\w*|art\b|artist\w*|film\w*|festival\w*|cultur\w*|folklore)\b/i],
 ['Health',/\b(?:health|medic\w*|disease\w*|vaccine\w*|flu\b|virus\w*|pandemic\w*|patient\w*|hospital\w*|mental health|trauma|childcare|maternal|maternity)\b/i],
 ['Environment',/\b(?:climate|wildfire\w*|flood\w*|drought\w*|pollution|poisoned water|rainforest|biodivers\w*|conservation|heat.fighting|earthquake\w*|disaster\w*|sea ice|glacier\w*|wetland\w*)\b/i],
 ['Conflict & Security',/\b(?:war\b|warfare|militar\w*|junta|gang\w*|armed|security|surveillance|trafficking|violence|airstrike|invasion|terror\w*|battle\w*|sanction\w*)\b/i],
 ['Economy',/\b(?:econom\w*|business\w*|trade|market\w*|inflation|tariff\w*|bank\w*|financ\w*|invest\w*|industry|labor|labour|worker\w*|employment|energy poverty|housing crisis|recruitment cost\w*|bioeconomy|fisheries)\b/i],
 ['Politics',/\b(?:politic\w*|election\w*|democra\w*|government\w*|parliament\w*|diplomac\w*|policy|law\b|bill\b|court\w*|protest\w*|rights?\b|president\w*|minister\w*)\b/i],
 ['Science & Technology',/\b(?:science|research\w*|technolog\w*|digital|satellite\w*|artificial intelligence|\bAI\b|data cent\w*|robot\w*|electric motor\w*|telecom\w*)\b/i]
]

/** A controlled, conservative provisional label. Body mentions alone are too
 * noisy to relabel a clear headline; ambiguous stories need editorial review. */
export function classifyNewsTopic({title='',text='',category=''}={}){
 if(NEWS_TOPICS.includes(category))return category
 const headline=String(title)
 const match=RULES.find(([,pattern])=>pattern.test(headline))
 if(match)return match[0]
 if(!headline.trim())return RULES.find(([,pattern])=>pattern.test(String(text).slice(0,1200)))?.[0]||'Society'
 return 'Society'
}

export function newsTopicCounts(stories=[]){
 const counts=Object.fromEntries(NEWS_TOPICS.map(topic=>[topic,0]))
 for(const story of stories)if(story?.contentType==='news')counts[classifyNewsTopic(story)]++
 return counts
}
