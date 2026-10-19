const worldScope=/\b(?:world|global|international|cross[- ]border|Europe|European|EU|Africa|African|Asia|Asian|Pacific|Latin America|Middle East|Ukraine|Ukrainian|Russia|Russian|China|Chinese|India|Indian|Bangladesh|Myanmar|Nepal|Cambodia|Brazil|Peru|Haiti|Sudan|Libya|Ghana|Mozambique|Ecuador|Jamaica|Venezuela|Croatia|Thailand|Korea|Iran|Israel|Palestine|Uyghur|Togo|Sahel|United Nations|NATO)\b/i
const publicAffairs=/\b(?:politic\w*|govern\w*|election\w*|democra\w*|parliament|diplomac\w*|sanction\w*|war|conflict|militar\w*|border|refugee\w*|migrat\w*|protest\w*|rights?|policy|law|econom\w*|trade|market\w*|inflation|tariff\w*|financ\w*|bank\w*|business\w*|industry|industrial|invest\w*|labor|labour|employment|food security|food insecurity|energy|technology|digital|data cent\w*|AI|artificial intelligence|surveillance|telecom\w*|climate|bioeconomy|satellite\w*|electric motor\w*|disaster\w*|flood\w*|wildfire\w*|pollution|humanitarian|trafficking|citizenship|violence|security|crisis|public health|health|vaccine\w*|medicine|culture|poetry|language|music|sport\w*|olympic\w*|histor\w*|geograph\w*|heritage)\b/i
const localOnly=/\b(?:Lansing|Michigan|Ingham|Eaton County|city council|county board|poll workers|housing pods|BWL|Erickson|Mason City|Flock camera\w*)\b/i

export function isFocusedNews(candidate){
 const title=String(candidate?.title||'')
 if(candidate?.sourceId==='public-domain-review')return /^https:\/\/publicdomainreview\.org\/essay\/[^/]+\/?$/i.test(candidate.sourceUrl||'')
 if(candidate?.sourceId==='nasa-earth')return /^https:\/\/science\.nasa\.gov\/earth\/earth-observatory\/[^/]+$/i.test(candidate.sourceUrl||'')&&
  /\b(?:climate|drought|flood\w*|fire\w*|hurricane\w*|storm\w*|sea ice|glacier\w*|rainforest|heat\w*|pollution|erosion|satellite\w*|earthquake\w*|el ni[ñn]o|water|agricultur\w*|crop\w*)\b/i.test(title)
 if(candidate?.sourceId==='rhinoceros')return !localOnly.test(title)&&
  /\b(?:global|international|cross[- ]border|U\.S\.|United States|federal|world)\b/i.test(title)&&publicAffairs.test(title)
 if(candidate?.sourceId==='horizon')return publicAffairs.test(title)
 if(candidate?.sourceId==='global-voices')return worldScope.test(title)&&publicAffairs.test(title)
 return true
}
