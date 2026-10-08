const fs = require('fs');
let code = fs.readFileSync('src/dashboard-js-render.ts', 'utf8');

code = code.replace(
  /const isFromAgent=m\.fromName!==\'lead\'&&m\.fromName!==\'system\';/,
  `const isFromAgent=m.fromName!=='lead'&&m.fromName!=='system'&&m.fromName!=='human';
    const isHuman=m.fromName==='human';
    const isBroadcast=!m.toName||m.toName==='all';`
);

code = code.replace(
  /const isPeer=isFromAgent&&m\.toName&&m\.toName!==\'lead\'&&m\.toName!==\'all\';/,
  `const isPeer=(isFromAgent||isHuman)&&!isBroadcast&&m.toName!=='lead';`
);

code = code.replace(
  /const align=isFromAgent\?\'mr-6\':\'ml-6\';/,
  `const align=isHuman?'ml-12':isFromAgent?'mr-6':'ml-6';`
);

code = code.replace(
  /const bubbleBg=isPeer\?\'bg-violet-500\/\[0\.06\] border-violet-500\/15\':isFromAgent\?\'bg-blue-500\/\[0\.06\] border-blue-500\/15\':\'bg-base-800\/40 border-base-700\/30\';/,
  `const bubbleBg=isHuman?'bg-emerald-500/[0.1] border-emerald-500/30':isPeer?'bg-violet-500/[0.06] border-violet-500/15':isFromAgent?'bg-blue-500/[0.06] border-blue-500/15':'bg-base-800/40 border-base-700/30';`
);

code = code.replace(
  /const avatarColor=m\.fromName===\'system\'\?\'bg-amber-500\/20 text-amber-400\':isPeer\?\'bg-violet-500\/20 text-violet-400\':isFromAgent\?\'bg-blue-500\/20 text-blue-400\':\'bg-emerald-500\/20 text-emerald-400\';/,
  `const avatarColor=m.fromName==='system'?'bg-amber-500/20 text-amber-400':isHuman?'bg-emerald-500/30 text-emerald-300':isPeer?'bg-violet-500/20 text-violet-400':isFromAgent?'bg-blue-500/20 text-blue-400':'bg-emerald-500/20 text-emerald-400';`
);

code = code.replace(
  /html\+=\'<span class=\"text-\[11px\] font-medium \'\+\(isPeer\?\'text-violet-400\':isFromAgent\?\'text-blue-400\':\'text-txt-300\'\)\+\'\">\'\+E\(m\.fromName\)\+\'<\/span>\';/,
  `html+='<span class="text-[11px] font-medium '+(isHuman?'text-emerald-400':isPeer?'text-violet-400':isFromAgent?'text-blue-400':'text-txt-300')+'">'+(isHuman?chip('VOCÊ','green'):E(m.fromName))+'</span>';`
);

fs.writeFileSync('src/dashboard-js-render.ts', code);
