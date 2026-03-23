// ═══ Pulse Push Server v3 — Cloudflare Worker ═══
// Web Push (via web-push lib) + ntfy.sh backup + message storage
import webpush from 'web-push';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Configure web-push with VAPID keys
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || 'mailto:pulse@example.com',
      env.VAPID_PUBLIC,
      env.VAPID_PRIVATE
    );

    const url = new URL(request.url);

    try {
      // POST /subscribe — register push subscription for a room + user
      if (url.pathname === '/subscribe' && request.method === 'POST') {
        const { room, userId, subscription } = await request.json();
        if (!room || !subscription || !subscription.endpoint) {
          return json({ error: 'missing room or subscription' }, 400);
        }
        const key = `subs:${room}`;
        const existing = JSON.parse(await env.SUBS.get(key) || '[]');
        // Remove old subscription for same endpoint, then add new
        const filtered = existing.filter(s => s.endpoint !== subscription.endpoint);
        filtered.push({ ...subscription, userId: userId || '' });
        await env.SUBS.put(key, JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      }

      // POST /send — store message + send Web Push + ntfy.sh backup
      if (url.pathname === '/send' && request.method === 'POST') {
        const { room, title, body, icon, senderId, senderName } = await request.json();
        if (!room) return json({ error: 'missing room' }, 400);

        // 1. Store message in KV
        const msgKey = `msg:${room}`;
        const msgs = JSON.parse(await env.SUBS.get(msgKey) || '[]');
        msgs.push({ title, body, icon, senderId, senderName, ts: Date.now() });
        await env.SUBS.put(msgKey, JSON.stringify(msgs.slice(-50)), { expirationTtl: 604800 });

        // 2. Send Web Push to all subscribers EXCEPT sender
        const subsKey = `subs:${room}`;
        const subs = JSON.parse(await env.SUBS.get(subsKey) || '[]');
        const payload = JSON.stringify({ title: title || 'pulse ♡', body: body || '', icon: icon || '♡' });

        const pushResults = await Promise.allSettled(
          subs.filter(s => s.userId !== senderId).map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                payload,
                { TTL: 86400, urgency: 'high' }
              );
              return 'sent';
            } catch (err) {
              if (err.statusCode === 410 || err.statusCode === 404) {
                return 'expired';
              }
              throw err;
            }
          })
        );

        // Clean up expired subscriptions
        const validSubs = subs.filter((sub, i) => {
          if (sub.userId === senderId) return true; // keep sender's sub
          const idx = subs.filter(s => s.userId !== senderId).indexOf(sub);
          if (idx === -1) return true;
          const result = pushResults[idx];
          return !(result.status === 'fulfilled' && result.value === 'expired');
        });
        if (validSubs.length !== subs.length) {
          await env.SUBS.put(subsKey, JSON.stringify(validSubs));
        }

        // 3. Also send via ntfy.sh as backup
        const ntfyTopic = 'pulse-' + room.toLowerCase();
        try {
          await fetch('https://ntfy.sh/' + ntfyTopic, {
            method: 'POST',
            headers: {
              'Title': title || 'pulse ♡',
              'Priority': '4',
              'Tags': 'heart',
              'Click': 'https://sem13bot.github.io/Pulseus/',
            },
            body: body || ''
          });
        } catch (e) { /* ntfy backup, ignore errors */ }

        const sent = pushResults.filter(r => r.status === 'fulfilled' && r.value === 'sent').length;
        return json({ ok: true, pushSent: sent, totalSubs: subs.length, stored: true });
      }

      // GET /messages/:room — fetch missed messages
      if (url.pathname.startsWith('/messages/') && request.method === 'GET') {
        const room = url.pathname.split('/messages/')[1];
        if (!room) return json({ error: 'missing room' }, 400);
        const since = parseInt(url.searchParams.get('since') || '0');
        const userId = url.searchParams.get('userId') || '';
        const msgs = JSON.parse(await env.SUBS.get(`msg:${room}`) || '[]');
        return json({ messages: msgs.filter(m => m.ts > since && m.senderId !== userId) });
      }

      // GET /ntfy-topic/:room
      if (url.pathname.startsWith('/ntfy-topic/')) {
        const room = url.pathname.split('/ntfy-topic/')[1] || '';
        return json({ topic: 'pulse-' + room.toLowerCase(), url: 'https://ntfy.sh/pulse-' + room.toLowerCase() });
      }

      if (url.pathname === '/health') {
        return json({ status: 'ok', version: 3 });
      }

      return json({ service: 'pulse-push', version: 3 });
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
