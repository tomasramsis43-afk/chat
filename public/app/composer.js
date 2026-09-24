import { el, esc, toast } from './ui.js';
import { icon } from './icons.js';
import { emitTyping, isConnected } from './socket.js';

const EMOJIS = ['😀','😄','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘','😎','🤩','🥳','😭','😢','😅','😔','🤔','😳','🙃','😴','🤯','😱','🔥','✨','🎉','❤️','🧡','💛','💚','💙','💜','🖤','💯','👍','👎','👌','🙏','👏','🤝','💪','🤲','✌️','🤟','👀','🤙','🙌','🫶','🍕','🍔','☕','🍵','🌹','🌟','🌙','☀️','⚡','🥹','🧠','🎀','💫','🕊️','🧿','✏️','📌','💔','❤️‍🔥','✅','❌','🥱','😤','🤫','🫡','🙈','🐱','🐶','🦁','🐼','🦋','🐝','🌵','🌸','⚽','🏆','🎮','🚗','⚡','🚀','📱','💻','📷','🎧','🎁','⏰','🌍','🎯','🧭','🩷'];

let replyTarget = null;
let onSendCallback = null;
let getActiveConv = () => null;
let lastTypingEmit = 0;

function setIcon(id, name) {
  el(id).innerHTML = icon(name, 19);
  return el(id);
}

export function initComposer(opts = {}) {
  onSendCallback = opts.onSend;
  getActiveConv = opts.getActiveConv || getActiveConv;
  const input = el('message-input');

  setIcon('attach-btn', 'clip').addEventListener('click', () => toast('رفع الملفات غير متاح بعد', 'warn'));
  el('emoji-btn').innerHTML = icon('smile', 20);
  setIcon('send-btn', 'send');
  setIcon('reply-cancel', 'close');

  autoSize();
  input.addEventListener('input', () => {
    autoSize();
    updateSend();
    const now = Date.now();
    const convId = getActiveConv();
    if (convId && now - lastTypingEmit > 1600) {
      emitTyping(convId);
      lastTypingEmit = now;
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el('message-form').requestSubmit();
    }
  });

  el('message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const content = input.value.trim();
    const convId = getActiveConv();
    if (!isConnected()) {
      toast('لا يوجد اتصال بالخادم — أعد المحاولة قريبًا');
      return;
    }
    if (!content || !convId) return;
    input.value = '';
    autoSize();
    updateSend();
    const target = replyTarget;
    clearReply();
    onSendCallback && onSendCallback(convId, content, target);
  });

  el('emoji-btn').addEventListener('click', () => {
    const panel = el('emoji-panel');
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      return;
    }
    if (panel.childElementCount === 0) {
      for (const em of EMOJIS) {
        const k = document.createElement('button');
        k.type = 'button';
        k.className = 'emoji-key';
        k.textContent = em;
        k.setAttribute('role', 'menuitem');
        k.addEventListener('click', () => {
          insertEmoji(em);
          if (panel.classList.contains('hidden')) return;
        });
        panel.appendChild(k);
      }
    }
    panel.classList.remove('hidden');
  });

  el('reply-cancel').addEventListener('click', clearReply);
  el('reply-bar').addEventListener('click', (e) => {
    if (e.target.closest('#reply-cancel')) return;
    if (replyTarget && opts.onReplyJump) opts.onReplyJump(replyTarget.id);
  });
}

function autoSize() {
  const t = el('message-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 156) + 'px';
}

function updateSend() {
  el('send-btn').disabled = !el('message-input').value.trim() || !isConnected();
}

export function setConnectedState() {
  updateSend();
}

function insertEmoji(em) {
  const t = el('message-input');
  const start = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? start;
  t.setRangeText(em, start, end, 'end');
  el('emoji-panel').classList.add('hidden');
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.focus();
}

export function closeEmoji() {
  el('emoji-panel').classList.add('hidden');
}

export function startReply(msg, senderName) {
  replyTarget = msg;
  el('reply-name').textContent = senderName ? esc(senderName) : 'مستخدم';
  el('reply-body').textContent = msg.deleted ? 'رسالة محذوفة' : msg.content || '';
  el('reply-bar').classList.remove('hidden');
  el('reply-bar').dataset.id = String(msg.id);
  el('message-input').focus();
}

export function getReplyTarget() {
  return replyTarget;
}

export function clearReply() {
  replyTarget = null;
  el('reply-bar').classList.add('hidden');
}

export function focusComposer() {
  el('message-input').focus();
}