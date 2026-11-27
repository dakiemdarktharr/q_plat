import {parse,evaluate,makePanel,ranks,finite,mean} from './dsl.mjs';
import {diagnostics,performance,splits,rng} from './metrics.mjs';
export const ENGINE_VERSION='q-engine-1.0.0';
export function validateConfig(input={}) {
  const c={capital:100000,feeBps:10,slippageBps:5,topK:5,rebalance:1,maxWeight:.25,lot:1,maxParticipation:.01,delay:0,maxHolding:52,entry:-1e12,exit:-1e12,horizon:1,riskFree:0,seed:41,...input};
  const limits={capital:[100,1e9],feeBps:[0,500],slippageBps:[0,500],topK:[1,64],rebalance:[1,52],maxWeight:[.01,1],lot:[.000001,1000],maxParticipation:[.00001,1],delay:[0,5],maxHolding:[1,5000],entry:[-1e12,1e12],exit:[-1e12,1e12],horizon:[1,12],riskFree:[-.1,1],seed:[0,4294967295]};
  for(const [k,[lo,hi]] of Object.entries(limits))if(!finite(c[k])||c[k]<lo||c[k]>hi)throw new Error(`Invalid ${k}: expected ${lo} to ${hi}.`);
  for(const k of ['topK','rebalance','delay','maxHolding','horizon','seed'])if(!Number.isInteger(c[k]))throw new Error(`${k} must be an integer.`);
  return Object.fromEntries(Object.keys(limits).map(k=>[k,c[k]]));
}
// Orders are sized at decision close, never next open. Next open only determines fill/cash capacity.
export function simulate(panel,score,input={},benchmarkMode=false) {
  const c=validateConfig(input),{matrix,dates,assets}=panel,A=assets.length;
  let cash=c.capital,costTotal=0;const qty=Array(A).fill(0),marks=Array(A).fill(null),held=Array(A).fill(0),pending=new Map(),series=[],ledger=[],points=[];
  const floorLot=q=>Math.floor((q+1e-10)/c.lot)*c.lot;
  for(let t=0;t<dates.length;t++) {
    let cost=0,traded=0,attempted=0,filled=0;
    const orders=(pending.get(t)||[]).sort((a,b)=>a.quantity-b.quantity);
    for(const o of orders) {
      const bar=matrix[t][o.a];attempted++;const event={...o,asset:assets[o.a],date:dates[t],orderTime:o.decisionTime,fillTime:bar?.openAt??null,settlementTime:bar?.openAt??null};
      if(!bar||!finite(bar.open)||bar.open<=0||!(bar.volume>0)) {ledger.push({...event,type:'rejected',reason:'Missing open or zero volume',filled:0});continue;}
      const sign=Math.sign(o.quantity),price=bar.open*(1+sign*c.slippageBps/10000);
      let q=Math.min(Math.abs(o.quantity),floorLot(bar.volume*c.maxParticipation));
      if(sign>0) q=Math.min(q,floorLot(Math.max(0,cash)/(price*(1+c.feeBps/10000))));else q=Math.min(q,qty[o.a]);
      q=floorLot(q)*sign;
      if(!q) {ledger.push({...event,type:'rejected',reason:'Cash, participation or lot constraint',filled:0});continue;}
      const fee=Math.abs(q*price)*c.feeBps/10000,slippage=Math.abs(q)*(Math.abs(price-bar.open));
      cash-=q*price+fee;qty[o.a]+=q;if(Math.abs(qty[o.a])<1e-8)qty[o.a]=0;
      cost+=fee+slippage;traded+=Math.abs(q*price);filled++;
      ledger.push({...event,type:'fill',filled:q,price,referencePrice:bar.open,fee,slippage,cashAfter:cash,quantityAfter:qty[o.a],reason:Math.abs(q)<Math.abs(o.quantity)?'Partial: cash/lot/participation':'Filled'});
    }
    matrix[t].forEach((r,a)=>{if(finite(r?.close))marks[a]=r.close;held[a]=qty[a]>0?held[a]+1:0;});
    const value=qty.reduce((s,q,a)=>s+q*(marks[a]??0),0),nav=cash+value;
    if(nav<-.001)throw new Error('Account invariant: negative NAV.');
    const scores=score[t],eligible=scores.map((v,a)=>({v,a})).filter(({v,a})=>finite(v)&&finite(matrix[t][a]?.close)&&matrix[t][a].close>0),rank=ranks(scores);
    const weights=Array(A).fill(0);let selected=[];
    if(t%c.rebalance===0) {
      selected=eligible.filter(x=>benchmarkMode||x.v>=(qty[x.a]>0?c.exit:c.entry)).filter(x=>!qty[x.a]||held[x.a]<c.maxHolding).sort((a,b)=>b.v-a.v||a.a-b.a).slice(0,benchmarkMode?A:c.topK);
      selected.forEach(x=>weights[x.a]=Math.min(c.maxWeight,1/selected.length));
      const due=t+1+c.delay,os=[];
      for(let a=0;a<A;a++) {
        const close=matrix[t][a]?.close;
        if(!finite(close)||close<=0)continue;
        const target=floorLot(nav*weights[a]/close),q=target-qty[a];
        if(Math.abs(q)>c.lot*.5 && due<dates.length)os.push({a,quantity:q,targetQuantity:target,targetWeight:weights[a],decisionDate:dates[t],decisionTime:matrix[t][a].availableAt,decisionPrice:close,score:scores[a],rank:rank[a]});
      }
      if(pending.has(due))pending.get(due).push(...os);else pending.set(due,os);
    }
    for(let a=0;a<A;a++) points.push({date:dates[t],asset:assets[a],score:scores[a],rank:rank[a],targetWeight:t%c.rebalance===0?weights[a]:null,quantity:qty[a],actualWeight:nav?qty[a]*(marks[a]??0)/nav:0,
      mark:marks[a],stale:!matrix[t][a],reason:t%c.rebalance!==0?'Not a rebalance session':!finite(scores[a])?'Warm-up or missing inputs':!weights[a]?'Outside top-K, threshold or holding limit':t+1+c.delay>=dates.length?'Terminal: no next open':'Target queued for next open'});
    costTotal+=cost;series.push({date:dates[t],nav,cash,cost,costTotal,turnover:nav?traded/nav:0,exposure:nav?value/nav:0,concentration:nav?qty.reduce((s,q,a)=>s+(q*(marks[a]??0)/nav)**2,0):0,attempted,filled,stalePositions:qty.filter((q,a)=>q>0&&!matrix[t][a]).length});
  }
  return {series,ledger,points,terminal:{cash,positions:assets.map((asset,a)=>({asset,quantity:qty[a],mark:marks[a]})).filter(x=>x.quantity),treatment:'Open positions marked at last known close; no forced liquidation. Price-only, no dividends. Immediate cash settlement; no margin or borrow.'}};
}
export function runResearch(rows,code,config,metadata) {
  const c=validateConfig(config),panel=makePanel(rows),ast=parse(code,metadata.fields),variables=evaluate(ast,panel),score=variables.score;
  const diag=diagnostics(panel,score,{horizon:c.horizon,kind:metadata.kind,seed:c.seed});
  const split=splits(panel.dates,c.horizon,metadata.kind);
  let account=null,metrics=null;
  if(metadata.kind!=='reference') {
    account=simulate(panel,score,c);const baseline=simulate(panel,score.map(r=>r.map(v=>finite(v)?1:null)),c,true);
    account.series.forEach((r,t)=>r.benchmark=baseline.series[t].nav);
    metrics=performance(account.series,{annualization:metadata.annualization,initialCapital:c.capital,riskFree:c.riskFree});
    metrics.fillRatio=account.series.reduce((s,r)=>s+r.filled,0)/Math.max(1,account.series.reduce((s,r)=>s+r.attempted,0));metrics.fills=account.ledger.filter(x=>x.type==='fill').length;
  }
  const ideal=diag.series.map((r,t)=>{const valid=score[t].map((s,a)=>({s,a,r:diag.labels[t][a]})).filter(x=>finite(x.s)&&finite(x.r)),rk=ranks(valid.map(x=>x.s),false),m=mean(rk),den=rk.reduce((s,r)=>s+Math.abs(r-m),0);return {date:r.date,grossExposure:den?1:0,netExposure:0,return:den?valid.reduce((s,x,i)=>s+(rk[i]-m)/den*x.r,0):null};});
  return {engine:ENGINE_VERSION,config:c,panel,ast,variables,diagnostic:diag,account,metrics,split,ideal,assumptions:{decision:'Observed close; conservative availableAt proxy',fill:metadata.kind==='reference'?'No fills: forward reference return only':'Next observed period open; quantity sized at decision close',benchmark:'equal-weight sample',longShort:'Ideal diagnostic only: gross 1, net 0, no borrow/funding model',quantilePaths:'Compounded overlapping-horizon labels are diagnostic only',fit:'No learned parameters in DSL. No full-sample standardization; ranks/zscores are contemporaneous.',holdoutOpened:true}};
}
export function robustness(rows,code,config,meta) {
  const c=validateConfig(config),panel=makePanel(rows),ast=parse(code,meta.fields),score=evaluate(ast,panel).score,random=rng(c.seed);
  const shuffled=score.map(row=>{const out=[...row];for(let i=out.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;});
  const trials=[{name:'Baseline / 1x costs',config:c,score},{name:'2x costs',config:{...c,feeBps:Math.min(500,c.feeBps*2),slippageBps:Math.min(500,c.slippageBps*2)},score},{name:'One extra period delay',config:{...c,delay:Math.min(5,c.delay+1)},score},{name:'Half universe (lexical even)',config:c,score:score.map(r=>r.map((v,a)=>a%2?null:v))},{name:'Shuffled null control',config:c,score:shuffled}];
  const results=trials.map(trial=>{const d=diagnostics(panel,trial.score,{kind:meta.kind,horizon:c.horizon,seed:c.seed});let ret=null,costs=null;if(meta.kind!=='reference'){const a=simulate(panel,trial.score,trial.config);ret=a.series.at(-1).nav/c.capital-1;costs=a.series.at(-1).costTotal;}return {name:trial.name,config:trial.config,meanIC:d.summary.meanIC,return:ret,costs};});
  const partition=splits(panel.dates,c.horizon,meta.kind),folds=partition.folds.map(f=>{
    // Select among two predeclared top-K values using ONLY purged train observations.
    const ks=[Math.max(1,Math.floor(c.topK/2)),c.topK],trials=ks.map(topK=>{
      const trainPanel={...panel,dates:panel.dates.slice(0,f.trainEnd+1),matrix:panel.matrix.slice(0,f.trainEnd+1)},s=score.slice(0,f.trainEnd+1);
      const metric=meta.kind==='reference'?diagnostics(trainPanel,s,{kind:meta.kind,horizon:c.horizon,seed:c.seed}).summary.meanIC:simulate(trainPanel,s,{...c,topK}).series.at(-1).nav/c.capital-1;return {topK,trainMetric:metric};
    });const best=[...trials].sort((a,b)=>(b.trainMetric??-Infinity)-(a.trainMetric??-Infinity))[0];
    const testPanel={...panel,dates:panel.dates.slice(f.testStart,f.testEnd+1),matrix:panel.matrix.slice(f.testStart,f.testEnd+1)},s=score.slice(f.testStart,f.testEnd+1),d=diagnostics(testPanel,s,{kind:meta.kind,horizon:c.horizon,seed:c.seed});
    const ret=meta.kind==='reference'?null:simulate(testPanel,s,{...c,topK:best.topK}).series.at(-1).nav/c.capital-1;
    return {...f,trials,selectedTopK:best.topK,oosIC:d.summary.meanIC,oosReturn:ret,purge:partition.purge};
  });return {trials:results,folds,seed:c.seed,note:'All trials shown. Top-K selected only on purged train; no fitting of DSL itself. Test score uses causal warm-up history. Holdout has now been opened.'};
}
