/** The former place-name Commons backfill cannot prove subject relevance. */
export function backfillCommonsMedia(){
 throw Error('Generic Wikimedia backfill is disabled; use scripts/repair-news-images.mjs to audit original article photos')
}

if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].replaceAll('\\','/').split('/').at(-1))){
 backfillCommonsMedia()
}
