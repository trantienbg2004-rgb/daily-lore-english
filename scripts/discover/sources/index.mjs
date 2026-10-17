import {source as voa} from './voa.mjs'
import {source as gv} from './globalVoices.mjs'
import {source as tc} from './theConversation.mjs'
import {source as bbc} from './bbc.mjs'
import {source as npr} from './npr.mjs'
import {source as unNews} from './unNews.mjs'
export const SOURCES = Object.freeze([voa,gv,tc,bbc,npr,unNews])
export const BY_ID = Object.freeze(Object.fromEntries(SOURCES.map(s=>[s.id,s])))
