// ═══ Pulse Message Server — Cloudflare Worker ═══
// Stores messages for offline delivery + sends via ntfy.sh
// Free tier: 100k requests/day

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      // POST /send — store message + push via ntfy.sh
      if (url.pathname === '/send' && request.method === 'POST') {
        const { room, title, body, icon, senderId, senderName } = await request.json();
        if (!room) return json({ error: 'missing room' }, 400);

        // 1. Store message in KV for later retrieval
        const key = `msg:${room}`;
        const msgs = JSON.parse(await env.SUBS.get(key) || '[]');
        const msg = { title, body, icon, senderId, senderName, ts: Date.now() };
        msgs.push(msg);
        // Keep last 50 messages, expire after 7 days
        const recent = msgs.slice(-50);
        await env.SUBS.put(key, JSON.stringify(recent), { expirationTtl: 604800 });

        // 2. Send push via ntfy.sh (proven, free, works on Android + iOS)
        const ntfyTopic = 'pulse-' + room.toLowerCase();
        try {
          await fetch('https://ntfy.sh/' + ntfyTopic, {
            method: 'POST',
            headers: {
              'Title': title || 'pulse ♡',
              'Priority': '4',
              'Tags': 'heart',
              'Click': 'https://sem13bot.github.io/Pulseus/',
              'Actions': 'view, Open pulse, https://sem13bot.github.io/Pulseus/'
            },
            body: body || ''
          });
        } catch (e) {
          // ntfy.sh might be down, that's ok — message is stored
        }

        return json({ ok: true, stored: recent.length });
      }

      // GET /messages/:room?since=timestamp&userId=xxx — fetch missed messages
      if (url.pathname.startsWith('/messages/') && request.method === 'GET') {
        const room = url.pathname.split('/messages/')[1];
        if (!room) return json({ error: 'missing room' }, 400);

        const since = parseInt(url.searchParams.get('since') || '0');
        const userId = url.searchParams.get('userId') || '';

        const key = `msg:${room}`;
        const msgs = JSON.parse(await env.SUBS.get(key) || '[]');

        // Filter: only messages after 'since' timestamp, exclude sender's own messages
        const filtered = msgs.filter(m => m.ts > since && m.senderId !== userId);

        return json({ messages: filtered });
      }

      // GET /health
      if (url.pathname === '/health') {
        return json({ status: 'ok', service: 'pulse-push', version: 2 });
      }

      // GET /ntfy-topic/:room — returns the ntfy.sh subscription URL
      if (url.pathname.startsWith('/ntfy-topic/')) {
        const room = url.pathname.split('/ntfy-topic/')[1];
        return json({
          topic: 'pulse-' + (room || '').toLowerCase(),
          subscribeUrl: 'https://ntfy.sh/pulse-' + (room || '').toLowerCase(),
          appUrl: 'https://ntfy.sh/pulse-' + (room || '').toLowerCase()
        });
      }

      return json({
        service: 'pulse-push',
        version: 2,
        endpoints: ['/send', '/messages/:room', '/ntfy-topic/:room', '/health']
      });
    } catch (e) {
      return json({ error: e.message }, 500);
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
