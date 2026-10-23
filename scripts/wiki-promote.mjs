import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promoteWikiCatalog} from './wiki/catalog.mjs'
import {verifyWikiRelease} from './build-reader-index.mjs'

const here=path.dirname(fileURLToPath(import.meta.url))
const source=path.resolve(here,'..')
const target=path.resolve(process.argv[2]||'')
if(!process.argv[2]||target===source)throw Error('Usage: node scripts/wiki-promote.mjs TARGET_CHECKOUT')
const before=await verifyWikiRelease(source)
if(!before.ready)throw Error('Staging Wiki catalog has no approved stories')
const result=await promoteWikiCatalog(source,target)
const after=await verifyWikiRelease(target)
console.log(JSON.stringify({added:result.added,total:after.total,targetMet:after.targetMet}))
