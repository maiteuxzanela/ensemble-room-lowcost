const fs = require('fs');
let html = fs.readFileSync('src/dashboard-html.ts', 'utf8');

const chatBarStr = `
<div id="chat-bar" class="fixed bottom-0 inset-x-0 bg-base-900/95 backdrop-blur border-t border-base-800 p-2 sm:p-3 flex items-end gap-2 z-50">
  <div class="relative shrink-0">
    <button id="chat-recipient-btn" class="h-9 px-3 rounded-md bg-base-800 hover:bg-base-700 border border-base-700 text-txt-200 text-sm font-medium transition-colors flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
      <span id="chat-recipient-label">📢 Todos</span>
      <svg class="w-3.5 h-3.5 text-txt-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
  </div>
  <div class="flex-1 relative">
    <textarea id="chat-input" rows="1" class="w-full bg-base-950 border border-base-700 rounded-md py-2 px-3 text-sm text-txt-100 placeholder-txt-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none max-h-32 scrollbar-thin transition-all" placeholder="Enviar mensagem para a sala ou digite @agente..."></textarea>
    <div id="chat-mentions" class="hidden absolute bottom-full left-0 mb-1 w-48 bg-base-800 border border-base-700 rounded-md shadow-lg overflow-hidden z-50">
      <ul id="chat-mentions-list" class="max-h-40 overflow-y-auto py-1 scroll text-sm text-txt-200"></ul>
    </div>
  </div>
  <button id="chat-send-btn" class="shrink-0 h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed">
    Enviar
  </button>
</div>
`;

// we will insert it before <div id="sco"
html = html.replace('<div id="sco"', chatBarStr + '\n<div id="sco"');
fs.writeFileSync('src/dashboard-html.ts', html);
