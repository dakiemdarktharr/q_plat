import {executeJob} from '../lib/jobs.mjs';
import {db} from '../lib/db.mjs';
export async function researchWorkflow(jobId) {
  'use workflow';
  try {let result;do{result=await execute(jobId);}while(result.status==='continue');return result;}catch {await recordFailure(jobId);return {status:'failed'};}
}
async function execute(jobId) {
  'use step';
  console.info('q_plat worker started',jobId);
  const summary=await executeJob(jobId);
  console.info('q_plat worker finished',jobId,summary.status);
  return summary; // IDs, counts and hashes only. Market rows stay in Atlas.
}
async function recordFailure(jobId){
  'use step';
  const database=await db();await database.collection('jobs').updateOne({_id:jobId,status:{$nin:['completed','cancelled']}},{$set:{status:'failed',error:'Worker exhausted retries. Retry the job to resume idempotently.'}});return true;
}
