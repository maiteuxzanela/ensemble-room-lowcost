const fs = require('fs');
let code = fs.readFileSync('src/dashboard-js-events.ts', 'utf8');

const chatEventsStr = `
// Chat Interaction
let chatRecipient = 'all';
let mentionsOpen = false;

function getActiveMembersForChat() {
  const t = cur();
  if(!t) return [];
  return (t.members || []).filter(m => m.status !== 'shut down').map(m => m.name);
}

function rChatMentions(query) {
  const list = document.getElementById('chat-mentions-list');
  const container = document.getElementById('chat-mentions');
  if (!list || !container) return;
  const activeMembersForChat = getActiveMembersForChat();
  const matches = activeMembersForChat.filter(m => m.toLowerCase().startsWith(query.toLowerCase()));
  if (matches.length === 0) {
    container.classList.add('hidden');
    mentionsOpen = false;
    return;
  }
  list.innerHTML = matches.map(m => \`<li class="px-3 py-1.5 hover:bg-base-700 cursor-pointer mention-item" data-name="\${m}">@\${m}</li>\`).join('');
  container.classList.remove('hidden');
  mentionsOpen = true;
  
  // click handlers for mention items
  list.querySelectorAll('.mention-item').forEach(el => {
    el.addEventListener('click', function() {
      applyMention(this.getAttribute('data-name'));
    });
  });
}

function applyMention(name) {
  const input = document.getElementById('chat-input');
  if(!input) return;
  const val = input.value;
  const atIdx = val.lastIndexOf('@');
  if(atIdx >= 0) {
    input.value = val.substring(0, atIdx) + '@' + name + ' ';
  }
  document.getElementById('chat-mentions').classList.add('hidden');
  mentionsOpen = false;
  input.focus();
}

document.addEventListener('click', function(e) {
  if(e.target.id === 'chat-recipient-btn' || e.target.closest('#chat-recipient-btn')) {
    const members = getActiveMembersForChat();
    const opts = ['all', ...members];
    let idx = opts.indexOf(chatRecipient);
    chatRecipient = opts[(idx + 1) % opts.length];
    document.getElementById('chat-recipient-label').textContent = chatRecipient === 'all' ? '📢 Todos' : '@' + chatRecipient;
  } else if (!e.target.closest('#chat-mentions') && document.getElementById('chat-mentions') && !document.getElementById('chat-mentions').classList.contains('hidden')) {
     document.getElementById('chat-mentions').classList.add('hidden');
     mentionsOpen = false;
  }
});

document.addEventListener('input', function(e) {
  if(e.target.id === 'chat-input') {
    const val = e.target.value;
    const atIdx = val.lastIndexOf('@');
    if(atIdx >= 0 && !val.includes(' ', atIdx)) {
      rChatMentions(val.substring(atIdx + 1));
    } else {
      const container = document.getElementById('chat-mentions');
      if (container) {
        container.classList.add('hidden');
        mentionsOpen = false;
      }
    }
  }
});

document.addEventListener('keydown', function(e) {
  if(e.target.id === 'chat-input') {
    if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if(text) {
        if(typeof sendChatMessage === 'function') {
          sendChatMessage(text, chatRecipient === 'all' ? undefined : chatRecipient);
        }
      }
    }
  }
});

document.addEventListener('click', function(e) {
  if(e.target.id === 'chat-send-btn' || e.target.closest('#chat-send-btn')) {
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : '';
    if(text) {
      if(typeof sendChatMessage === 'function') {
        sendChatMessage(text, chatRecipient === 'all' ? undefined : chatRecipient);
      }
    }
  }
});
`;

code = code.replace('\console.log(\'%c Ensemble Mission Control\',\'font-size:14px;font-weight:bold;color:#22c55e\');\n`;', chatEventsStr + '\nconsole.log(\'%c Ensemble Mission Control\',\'font-size:14px;font-weight:bold;color:#22c55e\');\n`;');

fs.writeFileSync('src/dashboard-js-events.ts', code);
