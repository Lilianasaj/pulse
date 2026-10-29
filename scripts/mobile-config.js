import {writeFileSync} from 'node:fs';
const url=new URL(process.argv[2]||process.env.CHAT_URL||'http://10.0.2.2:3000');
if(!['http:','https:'].includes(url.protocol))throw Error('Expected http(s) URL');
writeFileSync('capacitor.config.json',JSON.stringify({appId:'dev.pulse.chat',appName:'Pulse Chat',webDir:'dist',server:{url:url.origin,cleartext:url.protocol==='http:'},android:{allowMixedContent:false}},null,2)+'\n');
console.log('Mobile server URL:',url.origin);
