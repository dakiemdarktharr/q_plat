import {readFile} from 'node:fs/promises';
export const dynamic='force-dynamic';
export async function GET(){return new Response(await readFile(process.cwd()+'/index.html'),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}
