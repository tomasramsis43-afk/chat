import { api } from './api.js';
import { store, getConv, isPinned, isMuted } from './store.js';
import { refreshOneConv, reorderConversations } from './sidebar.js';
import { toast } from './ui.js';

const MUTE_DEFAULT_MS = 8 * 60 * 60 * 1000;

function applyConvPatch(convId, patch) {
  const conv = getConv(convId);
  if (!conv) return;
  Object.assign(conv, patch);
  store.conversations.set(convId, conv);
  refreshOneConv(conv);
  reorderConversations();
}

export async function togglePin(convId) {
  const next = !isPinned(convId);
  const prev = getConv(convId) ? getConv(convId).pinned : null;
  applyConvPatch(convId, { pinned: next });
  try {
    await api.post(`/api/conversations/${convId}/pin`, { pinned: next });
    toast(next ? 'تم تثبيت المحادثة' : 'أزيل التثبيت', 'ok');
  } catch (err) {
    if (prev !== null) applyConvPatch(convId, { pinned: prev });
    toast(err instanceof Error ? err.message : 'تعذّر تحديث التثبيت', 'error');
  }
}

export async function toggleMute(convId, label = 'المحادثة') {
  const next = !isMuted(convId);
  const prev = getConv(convId) ? getConv(convId).muted : null;
  const until = next ? new Date(Date.now() + MUTE_DEFAULT_MS).toISOString() : null;
  applyConvPatch(convId, { muted: next, mutedUntil: until });
  try {
    await api.post(`/api/conversations/${convId}/mute`, { until });
    toast(next ? `تم كتم ${label}` : `تم إلغاء كتم ${label}`, 'ok');
  } catch (err) {
    applyConvPatch(convId, { muted: !!prev, mutedUntil: prev ? until : null });
    toast(err instanceof Error ? err.message : 'تعذّر تحديث الكتم', 'error');
  }
}