import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {hash} from './db.mjs';
export const httpError=(message,status=400)=>Object.assign(new Error(message),{status});
export function safeEqual(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
export function owner(request){return !!process.env.OWNER_KEY&&safeEqual(request.headers.get('x-owner-key'),process.env.OWNER_KEY);}
export async function session(request,database,required=true){const raw=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('q_session='))?.slice(10);const s=raw?await database.collection('sessions').findOne({_id:hash(raw),expiresAt:{$gt:new Date()}}):null;if(!s&&required)throw httpError('Open a private workspace first.',401);return s;}
export async function login(database,body,create=false){
  const name=String(body.name||'').trim().toLowerCase(),password=String(body.password||'');
  if(!/^[a-z0-9_-]{3,48}$/.test(name)||password.length<12||password.length>256)throw httpError('Workspace: 3–48 letters/numbers/_/-. Passphrase: 12–256 characters.');
  let w=await database.collection('workspaces').findOne({name});
  if(create){if(w)throw httpError('Workspace name is already in use.',409);const salt=randomBytes(16).toString('hex');w={_id:randomBytes(16).toString('hex'),name,salt,passwordHash:scryptSync(password,salt,32).toString('hex'),createdAt:new Date().toISOString()};await database.collection('workspaces').insertOne(w);}
  else if(!w||!safeEqual(w.passwordHash,scryptSync(password,w.salt,32).toString('hex')))throw httpError('Invalid workspace or passphrase.',401);
  const token=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+30*86400000);
  await database.collection('sessions').insertOne({_id:hash(token),workspace:w._id,name:w.name,expiresAt});
  return {workspace:w._id,name:w.name,cookie:`q_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`};
}
export async function rateLimit(database,key,limit=30){const minute=Math.floor(Date.now()/60000),id=hash(key)+':'+minute;const r=await database.collection('rate_limits').findOneAndUpdate({_id:id},{$inc:{count:1},$setOnInsert:{expiresAt:new Date((minute+2)*60000)}},{upsert:true,returnDocument:'after'});if(r.count>limit)throw httpError('Rate limit reached. Try again in one minute.',429);}
export function sameOrigin(request){const origin=request.headers.get('origin');const allowed=process.env.APP_ORIGIN||new URL(request.url).origin;if(origin&&origin!==allowed)throw httpError('Cross-origin writes are not allowed.',403);}
