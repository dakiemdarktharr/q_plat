import {finite,mean,std,ranks} from './dsl.mjs';
export function correlation(x,y) {
  const p=x.map((v,i)=>[v,y[i]]).filter(([a,b])=>finite(a)&&finite(b));
  if(p.length<3) return null;
  const a=p.map(r=>r[0]),b=p.map(r=>r[1]),ma=mean(a),mb=mean(b);
  const den=Math.sqrt(a.reduce((s,v)=>s+(v-ma)**2,0)*b.reduce((s,v)=>s+(v-mb)**2,0));
  return den>0?a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0)/den:null;
}
export function spearman(x,y) {const p=x.map((v,i)=>[v,y[i]]).filter(([a,b])=>finite(a)&&finite(b));return correlation(ranks(p.map(r=>r[0])),ranks(p.map(r=>r[1])));}
export function rng(seed=20261127) {let x=seed>>>0;return ()=>{x+=0x6D2B79F5;let t=x;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
export function quantile(values,p) {const a=values.filter(finite).sort((a,b)=>a-b);if(!a.length)return null;const i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);}
export function bootstrap(values,seed=11,block=3) {
  const a=values.filter(finite);if(a.length<8)return {low:null,high:null,reason:'Fewer than 8 valid sessions.',n:a.length};
  const random=rng(seed),means=[];for(let k=0;k<400;k++){const sample=[];while(sample.length<a.length){const start=Math.floor(random()*a.length);for(let j=0;j<block&&sample.length<a.length;j++)sample.push(a[(start+j)%a.length]);}means.push(mean(sample));}
  return {low:quantile(means,0.025),high:quantile(means,0.975),n:a.length,block,replications:400,seed};
}
export function forwardLabels(panel,horizon=1,kind='ohlcv') {
  const {matrix}=panel;return matrix.map((row,t)=>row.map((r,a)=>{
    const entry=kind==='reference'?matrix[t]?.[a]?.close:matrix[t+1]?.[a]?.open;
    const exit=kind==='reference'?matrix[t+horizon]?.[a]?.close:matrix[t+1+horizon]?.[a]?.open;
    return finite(entry)&&entry>0&&finite(exit)?exit/entry-1:null;
  }));
}
export function diagnostics(panel,score,{horizon=1,kind='ohlcv',seed=11}={}) {
  const labels=forwardLabels(panel,horizon,kind), series=[],buckets=Array.from({length:5},()=>[]);let pairs=0,validScore=0;
  for(let t=0;t<panel.dates.length;t++) {
    const s=score[t],l=labels[t],eligible=s.map((v,a)=>({v,a,r:l[a]})).filter(x=>finite(x.v)&&finite(x.r)),rr=ranks(eligible.map(x=>x.v));
    const q=Array.from({length:5},()=>[]);eligible.forEach((x,i)=>q[Math.min(4,Math.floor(rr[i]*5))].push(x.r));
    const means=q.map(mean);means.forEach((m,i)=>{if(finite(m))buckets[i].push(m);});
    pairs+=eligible.length;validScore+=s.filter(finite).length;
    series.push({date:panel.dates[t],ic:spearman(s,l),n:eligible.length,quantiles:means,spread:finite(means[4])&&finite(means[0])?means[4]-means[0]:null,
      autocorrelation:t?spearman(score[t-1],s):null});
  }
  series.forEach((r,t)=>{r.rollingIC=mean(series.slice(Math.max(0,t-7),t+1).map(x=>x.ic));});
  const ics=series.map(x=>x.ic),decay=[1,2,4,8].map(h=>{const l=forwardLabels(panel,h,kind),ics=score.map((s,t)=>spearman(s,l[t]));return {horizon:h,meanIC:mean(ics),sessions:ics.filter(finite).length,byTime:ics};});
  const quantileEquity=Array(5).fill(1);series.forEach(r=>{r.quantileEquity=r.quantiles.map((v,i)=>{if(finite(v))quantileEquity[i]*=1+v;return quantileEquity[i];});});
  return {labels,series,summary:{meanIC:mean(ics),medianIC:quantile(ics,.5),sessions:ics.filter(finite).length,pairs,coverage:validScore/(panel.dates.length*panel.assets.length),
    rankAutocorrelation:mean(series.map(r=>r.autocorrelation)),quantiles:buckets.map(mean),confidence:bootstrap(ics,seed,Math.max(3,horizon)),
    reason:ics.some(finite)?null:'Need >=3 paired assets with nonconstant ranks and valid exits.',
    warning:panel.dates.length<60?'Short sample: uncertain estimates; UCI is 25 weekly observations per asset.':horizon>1?'Overlapping labels; quantile compounded paths are diagnostic, not a tradable portfolio.':null},decay};
}
export function performance(series,{annualization=252,riskFree=0,initialCapital=100000}={}) {
  if(!series.length)return {reason:'No observations.'};
  const returns=series.map((r,i)=>r.nav/(i?series[i-1].nav:initialCapital)-1),bench=series.map((r,i)=>r.benchmark/(i?series[i-1].benchmark:initialCapital)-1);
  const excess=returns.map(r=>r-riskFree/annualization),active=returns.map((r,i)=>r-bench[i]);
  const vol=std(returns),tracking=std(active),down=Math.sqrt(mean(excess.map(r=>Math.min(0,r)**2))??0);
  let peak=initialCapital,peakDate=series[0].date,worst=0,drawdown={peak:peakDate,trough:null,recovery:null};
  series.forEach(r=>{if(r.nav>=peak){peak=r.nav;peakDate=r.date;}r.drawdown=r.nav/peak-1;if(r.drawdown<worst){worst=r.drawdown;drawdown={peak:peakDate,trough:r.date,recovery:null,peakValue:peak};}});
  if(drawdown.trough)drawdown.recovery=series.find(r=>r.date>drawdown.trough&&r.nav>=drawdown.peakValue)?.date??null;
  const years=(Date.parse(series.at(-1).date)-Date.parse(series[0].date))/(365.25*86400000),last=series.at(-1);
  return {cumulativeReturn:last.nav/initialCapital-1,benchmarkReturn:last.benchmark/initialCapital-1,activeReturn:(last.nav-last.benchmark)/initialCapital,
    cagr:years>=1&&last.nav>0?(last.nav/initialCapital)**(1/years)-1:null,cagrReason:years<1?'Less than one calendar year.':null,
    volatility:vol===null?null:vol*Math.sqrt(annualization),sharpe:vol>0?mean(excess)/vol*Math.sqrt(annualization):null,
    sortino:down>0?mean(excess)/down*Math.sqrt(annualization):null,maxDrawdown:worst,drawdown,trackingError:tracking===null?null:tracking*Math.sqrt(annualization),
    informationRatio:tracking>0?mean(active)/tracking*Math.sqrt(annualization):null,annualization,riskFree,periods:series.length,
    costs:series.reduce((s,r)=>s+r.cost,0),turnover:series.reduce((s,r)=>s+r.turnover,0),meanExposure:mean(series.map(r=>r.exposure)),meanConcentration:mean(series.map(r=>r.concentration)),
    undefinedReason:'N/A ratios have insufficient observations or zero denominator. Population downside deviation; sample volatility. Risk-free is annual simple rate.'};
}
export function splits(dates,horizon=1,kind='ohlcv') {
  const n=dates.length,a=Math.floor(n*.6),b=Math.floor(n*.8),purge=horizon+(kind==='ohlcv'?1:0);
  return {train:{from:dates[0],to:dates[Math.max(0,a-purge-1)]},validation:{from:dates[a],to:dates[Math.max(a,b-purge-1)]},test:{from:dates[b],to:dates.at(-1)},purge,
    folds:[.4,.55,.7].map(f=>{const c=Math.floor(n*f),end=Math.min(n-1,c+Math.floor(n*.15));return {trainStart:0,trainEnd:c-purge-1,testStart:c,testEnd:end,trainTo:dates[c-purge-1],testFrom:dates[c],testTo:dates[end]};}).filter(f=>f.trainEnd>=5)};
}
export function asOfJoin(primary,secondary,maxAgeDays=7) {
  const sorted=[...secondary].sort((a,b)=>a.availableAt.localeCompare(b.availableAt));let j=-1;
  return primary.map(p=>{while(j+1<sorted.length&&sorted[j+1].availableAt<=p.availableAt)j++;const r=sorted[j],age=r?(Date.parse(p.availableAt)-Date.parse(r.availableAt))/86400000:null;
    return {...p,context:r&&age<=maxAgeDays?r.close:null,contextDate:r&&age<=maxAgeDays?r.date:null,ageDays:age};});
}
