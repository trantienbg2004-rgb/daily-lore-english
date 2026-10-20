import {verifyWikiRelease} from './build-reader-index.mjs'

try{
 const result=await verifyWikiRelease()
 console.log(`SAGA WIKIPEDIA VERIFIED: ${result.total} stories, ready=${result.ready}, ${result.images||0} distinct images`)
}catch(error){console.error(error);process.exitCode=1}
