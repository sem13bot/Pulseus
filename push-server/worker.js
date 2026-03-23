// ═══ Pulse Push Server — Cloudflare Worker ═══
// Handles Web Push subscriptions and notification delivery
// Free tier: 100k requests/day

const VAPID_PUBLIC = 'BB1SPfVQ61sJ6rnISO6icswRRYBaMXBblyxB_hqv6lWex0SjidQn0Nxd_EJQMa4J3s6BG2fXqKUD-CuUDkKK3zc';
const VAPID_PRIVATE = 'Bm5xYhcV7JoCKa7gKiMu0DCSx4IY0OGOTSipoIMUw5c';
const VAPID_SUBJECT = 'mailto:pulse@example.com';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      // POST /subscribe — register push subscription for a room
      if (url.pathname === '/subscribe' && request.method === 'POST') {
        const { room, subscription } = await request.json();
        if (!room || !subscription || !subscription.endpoint) {
          return json({ error: 'missing room or subscription' }, 400);
        }
        // Get existing subscriptions for this room
        const existing = JSON.parse(await env.SUBS.get(room) || '[]');
        // Don't add duplicates
        if (!existing.find(s => s.endpoint === subscription.endpoint)) {
          existing.push(subscription);
          await env.SUBS.put(room, JSON.stringify(existing));
        }
        return json({ ok: true, count: existing.length });
      }

      // POST /notify — send push notification to all subscribers in a room
      if (url.pathname === '/notify' && request.method === 'POST') {
        const { room, title, body, icon, senderId } = await request.json();
        if (!room) return json({ error: 'missing room' }, 400);

        const subs = JSON.parse(await env.SUBS.get(room) || '[]');
        if (subs.length === 0) return json({ sent: 0, total: 0 });

        const payload = JSON.stringify({ title: title || 'pulse ♡', body: body || '', icon: icon || '♡' });

        const results = await Promise.allSettled(
          subs.map(sub => sendWebPush(sub, payload))
        );

        // Remove expired/invalid subscriptions (410 Gone or 404)
        const validSubs = [];
        for (let i = 0; i < subs.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled' || (r.reason && r.reason.status && r.reason.status < 400)) {
            validSubs.push(subs[i]);
          } else if (r.reason && r.reason.status === 410) {
            // Subscription expired — remove it
          } else if (r.reason && r.reason.status === 404) {
            // Subscription not found — remove it
          } else {
            // Other error — keep subscription (might be temporary)
            validSubs.push(subs[i]);
          }
        }
        if (validSubs.length !== subs.length) {
          await env.SUBS.put(room, JSON.stringify(validSubs));
        }

        const sent = results.filter(r => r.status === 'fulfilled').length;
        return json({ sent, total: subs.length });
      }

      // POST /unsubscribe — remove a subscription
      if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        const { room, endpoint } = await request.json();
        if (!room || !endpoint) return json({ error: 'missing room or endpoint' }, 400);
        const existing = JSON.parse(await env.SUBS.get(room) || '[]');
        const filtered = existing.filter(s => s.endpoint !== endpoint);
        await env.SUBS.put(room, JSON.stringify(filtered));
        return json({ ok: true, remaining: filtered.length });
      }

      // GET /health
      if (url.pathname === '/health') {
        return json({ status: 'ok', service: 'pulse-push' });
      }

      return json({ service: 'pulse-push', endpoints: ['/subscribe', '/notify', '/unsubscribe', '/health'] });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ═══ CORS ═══
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

// ═══ Web Push Sending (RFC 8291 + VAPID) ═══

async function sendWebPush(subscription, payload) {
  const jwt = await createVapidJwt(subscription.endpoint);
  const encrypted = await encryptPayload(subscription, payload);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high',
      'Topic': 'pulse',
    },
    body: encrypted,
  });

  if (!response.ok) {
    const err = new Error(`Push failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response;
}

// ═══ VAPID JWT (ES256) ═══

async function createVapidJwt(endpoint) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 86400;

  const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = btoa(JSON.stringify({ aud, exp, sub: VAPID_SUBJECT }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = `${header}.${body}`;

  // Import VAPID private key
  const pubBytes = b64url2bytes(VAPID_PUBLIC);
  const privBytes = b64url2bytes(VAPID_PRIVATE);

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      x: bytes2b64url(pubBytes.slice(1, 33)),
      y: bytes2b64url(pubBytes.slice(33, 65)),
      d: bytes2b64url(privBytes),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(token)
  ));

  return `${token}.${bytes2b64url(sig)}`;
}

// ═══ Payload Encryption (RFC 8291 — aes128gcm) ═══

async function encryptPayload(subscription, payloadStr) {
  const clientPubKey = b64url2bytes(subscription.keys.p256dh);
  const clientAuth = b64url2bytes(subscription.keys.auth);

  // Generate ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const ephemeralPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey)
  );

  // Import client's public key for ECDH
  const clientKey = await crypto.subtle.importKey(
    'raw', clientPubKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // Shared secret via ECDH
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientKey },
      ephemeral.privateKey,
      256
    )
  );

  // Generate 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Info for IKM derivation: "WebPush: info\0" || client_public || server_public
  const infoPrefix = new TextEncoder().encode('WebPush: info\0');
  const ikmInfo = new Uint8Array(infoPrefix.length + clientPubKey.length + ephemeralPubRaw.length);
  ikmInfo.set(infoPrefix, 0);
  ikmInfo.set(clientPubKey, infoPrefix.length);
  ikmInfo.set(ephemeralPubRaw, infoPrefix.length + clientPubKey.length);

  // IKM = HKDF(salt=clientAuth, ikm=sharedSecret, info=ikmInfo, length=32)
  const sharedKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: clientAuth, info: ikmInfo },
    sharedKey, 256
  ));

  // CEK = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\0", length=16)
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const cekBytes = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') },
    ikmKey, 128
  ));

  // Nonce = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\0", length=12)
  const ikmKey2 = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\0') },
    ikmKey2, 96
  ));

  // Pad payload: content + delimiter (0x02)
  const content = new TextEncoder().encode(payloadStr);
  const padded = new Uint8Array(content.length + 1);
  padded.set(content);
  padded[content.length] = 2;

  // Encrypt with AES-128-GCM
  const cek = await crypto.subtle.importKey('raw', cekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cek, padded
  ));

  // Build aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(65)
  const recordSize = encrypted.length + 86;
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = 65; // ephemeral public key length
  header.set(ephemeralPubRaw, 21);

  // Combine header + encrypted
  const body = new Uint8Array(86 + encrypted.length);
  body.set(header);
  body.set(encrypted, 86);
  return body;
}

// ═══ Base64URL Utilities ═══

function b64url2bytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
  const bin = atob(b64 + pad);
  return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
}

function bytes2b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
