import fs from 'node:fs';
const eng = await import('./open-sse/rtk/selfMeasuringBypass.js');
const t = fs.readFileSync('/tmp/cx_answer.txt','utf8');
console.log('classifyOutcome:', eng.classifyOutcome(t));
console.log('hasDeed:', eng.hasDeed?.(t), 'exports:', Object.keys(eng).join(','));
