import {Unzip,UnzipInflate,strFromU8} from 'fflate';
import {CATALOG} from './catalog.mjs';
import {rng} from './metrics.mjs';
import {hash,bulkUpsert} from './db.mjs';
export function csv(text) {
  const lines=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x!==''))lines.push(row);row=[];field='';}else field+=c;}
  if(quoted)throw new Error('Unterminated CSV quote.');if(field||row.length){row.push(field);lines.push(row);}if(!lines.length)return [];
  const headers=lines.shift().map(x=>x.replace(/^\uFEFF/,'').trim());return lines.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]?.trim()??''])));
}
const dateISO=d=>d.toISOString().slice(0,10);
export function parseUCI(text) {
  return csv(text).map(r=>{
    if(!r.stock||!r.date)throw new Error('Unexpected UCI schema.');const [m,d,y]=r.date.split('/').map(Number),date=dateISO(new Date(Date.UTC(y,m-1,d))),weekOpen=new Date(date+'T14:30:00Z');weekOpen.setUTCDate(weekOpen.getUTCDate()-((weekOpen.getUTCDay()+6)%7));
    const row={asset:r.stock,date,availableAt:date+'T23:59:00Z',openAt:weekOpen.toISOString(),group:'UCI sample'};
    for(const f of ['open','high','low','close','volume']){const n=Number(r[f]?.replace(/[$,]/g,''));if(!Number.isFinite(n)||n<0)throw new Error('Invalid UCI numeric field.');row[f]=n;}
    // Deliberately never copy next-week, dividend, percent-return or unknown source fields.
    return row;
  });
}
export function parseECB(text) {
  return csv(text).filter(r=>r.OBS_VALUE!==''&&r.OBS_VALUE!==undefined).map(r=>{
    const asset=r.CURRENCY,date=r.TIME_PERIOD,close=Number(r.OBS_VALUE);if(!['USD','GBP','JPY','CHF','CAD','AUD'].includes(asset)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(close>0))throw new Error('Unexpected ECB schema.');
    return {asset,date,close,availableAt:new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString(),observationStatus:r.OBS_STATUS||null};
  });
}
export function synthetic(seed=271828,sessions=1200,assets=28) {
  const random=rng(seed),rows=[],prices=Array.from({length:assets},(_,a)=>40+a*4),prev=Array(assets).fill(0);let date=new Date('2018-01-01T00:00:00Z');
  for(let t=0;t<sessions;t++){
    while([0,6].includes(date.getUTCDay()))date.setUTCDate(date.getUTCDate()+1);const day=dateISO(date),regime=Math.floor(t/200)%3,market=(random()-.5)*.016;
    for(let a=0;a<assets;a++){
      const innovation=(random()-.5)*.035,trend=regime===0?.12*prev[a]:regime===1?-.08*prev[a]:0,open=prices[a]*(1+(random()-.5)*.006),ret=market+innovation+trend+.00015,close=open*(1+ret),spread=random()*.014;
      prices[a]=close;prev[a]=ret;if((a===assets-1&&t<200)||(t+a*11)%137===0)continue;
      rows.push({asset:`S${String(a+1).padStart(2,'0')}`,date:day,openAt:day+'T14:30:00Z',availableAt:day+'T21:01:00Z',open,high:Math.max(open,close)*(1+spread),low:Math.min(open,close)*(1-spread),close,volume:(t+a)%97===0?0:Math.floor(100000+random()*900000),group:`Sector ${a%4+1}`,regime});
    }date.setUTCDate(date.getUTCDate()+1);
  }return rows;
}
export function corporateActionFixture(){return {name:'Synthetic split fixture',splitRatio:2,rawBefore:100,rawAfter:50,sharesBefore:100,sharesAfter:200,navBefore:10000,navAfter:10000,adjustment:'Separate fixture; not mixed into research panel.'};}
async function boundedFetch(url,max=32*1024*1024) {
  const res=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(90000),redirect:'error',headers:{Accept:'text/csv, application/zip, */*'}});if(!res.ok)throw new Error(`Publisher returned HTTP ${res.status}`);
  let size=0;const chunks=[];for await(const chunk of res.body){size+=chunk.length;if(size>max)throw new Error('Publisher response exceeded RAM buffer limit.');chunks.push(chunk);}return Buffer.concat(chunks);
}
function uciZip(buffer) {
  let output=null,total=0,error=null;
  const unzip=new Unzip(file=>{if(!file.name.endsWith('.data'))return;const parts=[];file.ondata=(err,data,final)=>{if(err){error=err;return;}total+=data.length;if(total>4*1024*1024){file.terminate();error=new Error('ZIP expanded-size limit.');return;}parts.push(data);if(final)output=Buffer.concat(parts);};file.start();});
  unzip.register(UnzipInflate);unzip.push(buffer,true);if(error)throw error;if(!output)throw new Error('UCI .data member missing.');return strFromU8(output);
}
export function canonicalRows(rows) {return [...rows].sort((a,b)=>a.date.localeCompare(b.date)||a.asset.localeCompare(b.asset)).map(r=>Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])));}
export async function ingest(database,dataset,check=async()=>{}) {
  if(!process.env.VERCEL_DEPLOYMENT_ID)throw new Error('Ingestion is cloud-only. Local dataset downloads are prohibited.');
  const meta=CATALOG[dataset];if(!meta)throw new Error('Dataset not in audited source catalog.');
  let rows;if(dataset==='synthetic')rows=synthetic(meta.seed);else{const bytes=await boundedFetch(meta.download);rows=dataset==='uci'?parseUCI(uciZip(bytes)):parseECB(bytes.toString('utf8'));}
  rows=canonicalRows(rows);const checksum=hash(rows),version=`${dataset}-${checksum.slice(0,20)}`;
  const exists=await database.collection('dataset_versions').findOne({_id:version,status:'ready'});
  if(exists){const count=await database.collection('bars').countDocuments({version});if(count!==exists.count)throw new Error('Existing snapshot count mismatch.');return {version,count,checksum,idempotent:true};}
  const keys=new Set(rows.map(r=>r.asset+'|'+r.date)),assets=[...new Set(rows.map(r=>r.asset))].sort(),dates=[...new Set(rows.map(r=>r.date))].sort();
  if(keys.size!==rows.length)throw new Error('Duplicate publisher observation.');if(dataset==='uci'&&(rows.length!==750||assets.length!==30))throw new Error('UCI count contract changed.');if(dataset==='ecb'&&(assets.length!==6||dates.length<3500))throw new Error('ECB coverage contract failed.');
  for(const r of rows)if(meta.kind==='ohlcv'&&(!(r.low<=Math.min(r.open,r.close))||!(r.high>=Math.max(r.open,r.close))))throw new Error('OHLC invariant failed.');
  const now=new Date().toISOString();
  await database.collection('dataset_versions').updateOne({_id:version},{$setOnInsert:{dataset,status:'staging',createdAt:now,schemaVersion:1,checksum,meta}},{upsert:true});
  const staged=await database.collection('dataset_versions').findOne({_id:version});
  const start=staged.checkpoint||0,end=Math.min(rows.length,start+4000);
  for(let i=start;i<end;i+=400){await check();await bulkUpsert(database.collection('bars'),rows.slice(i,Math.min(i+400,end)).map(r=>({...r,version})),['version','asset','date']);await database.collection('dataset_versions').updateOne({_id:version,status:'staging'},{$max:{checkpoint:Math.min(i+400,end)}});}
  if(end<rows.length)return {status:'continue',version,checkpoint:end,total:rows.length};
  await check();const count=await database.collection('bars').countDocuments({version});if(count!==rows.length)throw new Error('Snapshot readback count mismatch.');
  const readback=await database.collection('bars').find({version},{projection:{_id:0,version:0}}).sort({date:1,asset:1}).toArray();if(hash(canonicalRows(readback))!==checksum)throw new Error('Snapshot readback checksum mismatch.');
  const quality={duplicates:0,missingRows:assets.length*dates.length-count,coverage:count/(assets.length*dates.length),zeroVolume:rows.filter(r=>r.volume===0).length,fields:Object.fromEntries(meta.fields.map(f=>[f,{type:'number',unit:meta.units[f],missing:rows.filter(r=>!Number.isFinite(r[f])).length}]))};
  await database.collection('dataset_versions').updateOne({_id:version},{$set:{status:'ready',count,assets,from:dates[0],to:dates.at(-1),sessions:dates.length,quality,retrievedAt:now,readyAt:new Date().toISOString(),fixture:dataset==='synthetic'?corporateActionFixture():null}});
  await database.collection('datasets').updateOne({_id:dataset},{$set:{currentVersion:version,...meta}},{upsert:true});
  return {version,count,checksum,idempotent:false};
}
