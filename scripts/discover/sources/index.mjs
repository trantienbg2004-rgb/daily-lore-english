import {source as gv} from './globalVoices.mjs'
import {source as tc} from './theConversation.mjs'
import {source as bbc} from './bbc.mjs'
import {source as npr} from './npr.mjs'
import {source as rhinoceros} from './rhinoceros.mjs'
import {source as horizon} from './horizon.mjs'
import {source as nasaEarth} from './nasaEarth.mjs'
import {source as publicDomainReview} from './publicDomainReview.mjs'
export const SOURCES = Object.freeze([gv,horizon,nasaEarth,publicDomainReview,rhinoceros,tc,bbc,npr])
export const BY_ID = Object.freeze(Object.fromEntries(SOURCES.map(s=>[s.id,s])))
