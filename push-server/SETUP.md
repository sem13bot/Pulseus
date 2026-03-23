# Push Server Setup (5 minutes, free forever)

## Why?
Browsers can ONLY receive push notifications from a server.
When the browser is closed, the MQTT WebSocket dies.
This Cloudflare Worker sends push notifications for free (100k/day).

## Steps

### 1. Create free Cloudflare account
Go to https://dash.cloudflare.com/sign-up (no credit card needed)

### 2. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 3. Login to Cloudflare
```bash
wrangler login
```

### 4. Create KV namespace for storing subscriptions
```bash
cd push-server
wrangler kv namespace create SUBS
```
Copy the `id` from the output and paste it in `wrangler.toml` replacing `REPLACE_WITH_KV_ID`.

### 5. Deploy
```bash
wrangler deploy
```

### 6. Copy your Worker URL
It will show something like: `https://pulse-push.YOUR_USERNAME.workers.dev`

### 7. Update the app
In `index.html`, find `PUSH_SERVER` and replace with your Worker URL:
```javascript
var PUSH_SERVER = 'https://pulse-push.YOUR_USERNAME.workers.dev';
```

### Done!
Push notifications will now work even when the browser is completely closed.
