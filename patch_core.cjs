const fs = require('fs');
let code = fs.readFileSync('src/dashboard-js-core.ts', 'utf8');

const sendChatFuncStr = `
async function sendChatMessage(text, target) {
  const input = document.getElementById('chat-input');
  if (input) input.disabled = true;
  const btn = document.getElementById('chat-send-btn');
  if (btn) btn.disabled = true;

  try {
    const t = cur();
    const teamId = t ? t.id : '';
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, text, to: target })
    });
    if (!res.ok) throw new Error('Chat send failed: ' + res.statusText);
    
    // clear input
    if (input) {
      input.value = '';
      input.style.height = 'auto'; // reset textarea height if auto-resizing
    }
  } catch (err) {
    console.error(err);
    alert('Erro ao enviar mensagem: ' + err.message);
  } finally {
    if (input) {
      input.disabled = false;
      input.focus();
    }
    if (btn) btn.disabled = false;
  }
}
`;

code = code.replace('export const DASHBOARD_JS_CORE = `\n', 'export const DASHBOARD_JS_CORE = `\n' + sendChatFuncStr + '\n');

fs.writeFileSync('src/dashboard-js-core.ts', code);
