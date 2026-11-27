/* HE Workshop job control — Supabase bridge.
   Gives the app the same data / photo / download / log-in functions it has on the workshop server,
   backed by Supabase. Settings come from config.js (window.HE_CONFIG). */
(function () {
  'use strict';
  const C = window.HE_CONFIG || {};
  const NOCFG = !C.url || !C.anonKey || /YOUR-PROJECT|PASTE/i.test(C.url + C.anonKey);
  const sb = NOCFG ? null : window.supabase.createClient(C.url, C.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'he-workshop-auth' },
    realtime: { params: { eventsPerSecond: 5 } }
  });

  /* ---------- names → hidden log-in e-mails (same rule as the he-auth function) ---------- */
  const nameKey = n => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const hex = s => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
  const userEmail = n => 'u.' + hex(nameKey(n)) + '@hews.app';
  const OP_EMAIL = { cut: 'cutting@ops.hews.app', bend: 'bending@ops.hews.app' };
  const ROLES = {
    admin: { role: 'admin' }, user: { role: 'user' },
    op_cut: { role: 'op', kind: 'cut', name: 'Cutting operator' },
    op_bend: { role: 'op', kind: 'bend', name: 'Bending operator' }
  };

  const OFFLINE = NOCFG
    ? 'This website is not connected to Supabase yet: open config.js and paste your Supabase Project URL and anon key (see SETUP-GUIDE).'
    : 'Can’t reach Supabase. Check the internet connection, then try again.';
  const offline = () => { const e = new Error(OFFLINE); e.offline = true; return e; };
  const isNet = e => !e || /fetch|network|Load failed|NetworkError|timeout/i.test(String(e.message || e)) || e.name === 'FunctionsFetchError';

  async function fn(action, body) {
    if (!sb) throw offline();
    let res;
    try { res = await sb.functions.invoke('he-auth', { body: Object.assign({ action }, body || {}) }); }
    catch (e) { throw offline(); }
    if (res.error) {
      if (res.error.name === 'FunctionsFetchError' || res.error.name === 'FunctionsRelayError') {
        const e = new Error('The he-auth function is not reachable. Check that it is deployed in Supabase (see SETUP-GUIDE, step 3).'); throw e;
      }
      let msg = res.error.message;
      try { const j = await res.error.context.json(); msg = j.error || msg; } catch (x) { /* keep */ }
      throw new Error(msg);
    }
    return res.data;
  }

  /* ---------- who is logged in ---------- */
  let wasIn = false;
  // Is this log-in still valid on the server? (password changed or person removed → no)
  async function stillValid() {
    try {
      const { error } = await sb.auth.getUser();
      if (error && !isNet(error) && /session|jwt|token|not.?found|invalid|expired|403|401/i.test((error.code || '') + ' ' + error.message)) {
        await sb.auth.signOut({ scope: 'local' }); return false;
      }
    } catch (e) { /* offline: keep going */ }
    return true;
  }
  async function profile(check) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    if (check && !(await stillValid())) return null;
    const { data, error } = await sb.from('app_users').select('name,role').eq('user_id', session.user.id).maybeSingle();
    if (error) { if (isNet(error)) throw offline(); throw new Error(error.message); }
    if (!data) { await sb.auth.signOut({ scope: 'local' }); return null; }   // removed by the administrator
    const r = ROLES[data.role] || ROLES.user;
    wasIn = true;
    return { role: r.role, name: r.name || data.name, id: session.user.id, kind: r.kind };
  }
  async function signIn(email, pw) {
    const { error } = await sb.auth.signInWithPassword({ email, password: String(pw || '') });
    if (error) {
      if (isNet(error)) throw offline();
      throw new Error(/invalid|credentials/i.test(error.message) ? 'Wrong name or password.' : error.message);
    }
  }
  const status3 = async () => { const st = await fn('status'); return { me: null, setup: !!st.setup, setupCode: !!st.setupCode, op: st.op || {} }; };

  const USERS = { GET: 'list', POST: 'add' };
  window.HE_AUTH = {
    async me() {
      if (!sb) throw offline();
      const m = await profile(true);
      return m ? { me: m, setup: false, op: {} } : status3();
    },
    async login(b) {
      if (!sb) throw offline();
      const email = b.kind === 'u' ? userEmail(b.name) : OP_EMAIL[b.kind];
      if (!email) throw new Error('bad request');
      await signIn(email, b.pw);
      const m = await profile();
      const okKind = m && (b.kind === 'u' ? m.role !== 'op' : m.role === 'op' && m.kind === b.kind);
      if (!okKind) { await sb.auth.signOut({ scope: 'local' }); throw new Error('Wrong name or password.'); }
      return { me: m };
    },
    async setup(b) {
      await fn('setup', { name: b.name, pw: b.pw, code: b.code });
      await signIn(userEmail(b.name), b.pw);
      return { me: await profile() };
    },
    async logout() { wasIn = false; if (sb) await sb.auth.signOut({ scope: 'local' }); return { ok: true }; },
    async admin(method, path, body) {
      if (path === '/users') return fn(USERS[method], body);
      let m = /^\/users\/(.+)\/logout$/.exec(path);
      if (m) return fn('logout', { id: m[1] });
      m = /^\/op\/(cut|bend)\/logout$/.exec(path);
      if (m) return fn('oplogout', { kind: m[1] });
      m = /^\/users\/(.+)$/.exec(path);
      if (m) {
        if (method === 'DELETE') return fn('remove', { id: m[1] });
        if (body && body.role) return fn('role', { id: m[1], role: body.role });
        return fn('password', { id: m[1], pw: body && body.pw });
      }
      m = /^\/op\/(cut|bend)$/.exec(path);
      if (m) return fn('oppw', { kind: m[1], pw: body && body.pw });
      throw new Error('unknown request');
    }
  };
  if (sb) sb.auth.onAuthStateChange(ev => {
    // logged out somewhere else (password changed, person removed): back to the welcome page
    if (ev === 'SIGNED_OUT' && wasIn) { wasIn = false; location.replace(location.pathname + location.search); }
  });

  /* ---------- connection banner ---------- */
  function status(ok) {
    let el = document.getElementById('conn');
    if (!el) {
      el = document.createElement('div'); el.id = 'conn';
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:70;padding:8px 12px;border-radius:8px;font:600 14px system-ui,sans-serif;background:#e0301e;color:#fff;display:none';
      document.body.appendChild(el);
    }
    el.textContent = 'No connection to Supabase — reconnecting…'; el.style.display = ok ? 'none' : 'block';
  }

  /* ---------- the shared workshop data ---------- */
  let lastV = 0, pending = 0, deferred = false, deliver = null, refreshing = null;
  async function readRow() {
    const { data, error } = await sb.from('shop_state').select('data,version').eq('id', 'main').maybeSingle();
    if (error) throw error;
    return data;
  }
  function apply(row) {
    if (!row || num(row.version) <= lastV) return;
    lastV = num(row.version);
    deliver && deliver({ exists: true, data: () => row.data, metadata: { fromCache: false, hasPendingWrites: false } });
  }
  const num = v => Number(v) || 0;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = readRow().then(r => {
      status(true);
      if (!r) profile().catch(() => {});   // no access any more? profile() logs out if removed
      apply(r);
    }).catch(() => status(false)).finally(() => { refreshing = null; });
    return refreshing;
  }
  const db = {
    doc() {
      return {
        async get() { const r = await readRow(); return { exists: !!r, data: () => r && r.data, metadata: { fromCache: false } }; },
        async set(d) {
          pending++;
          try {
            const { data, error } = await sb.from('shop_state').upsert({ id: 'main', data: d }).select('version').single();
            if (error) throw error;
            lastV = Math.max(lastV, num(data.version)); status(true);
          } catch (e) {
            if (isNet(e)) { status(false); throw { code: 'unavailable', message: 'Supabase not reachable' }; }
            throw { code: 'permission-denied', message: e.message || 'not allowed — log in again' };
          } finally {
            pending--;
            if (!pending && deferred) { deferred = false; refresh(); }
          }
        },
        async update(d) { return this.set(d); },
        onSnapshot(next) {
          deliver = next;
          refresh();
          const ch = sb.channel('he-shop-state')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_state', filter: 'id=eq.main' }, p => {
              const v = num(p.new && p.new.version);
              if (v && v <= lastV) return;
              if (pending) { deferred = true; return; }
              refresh();
            })
            .subscribe(st => { if (st === 'SUBSCRIBED') { status(true); refresh(); } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') status(false); });
          const iv = setInterval(() => { refresh(); stillValid(); }, 60000);   // safety net + log-out check
          const vis = () => { if (document.visibilityState === 'visible') { refresh(); stillValid(); } };
          document.addEventListener('visibilitychange', vis);
          return () => { deliver = null; clearInterval(iv); document.removeEventListener('visibilitychange', vis); sb.removeChannel(ch); };
        }
      };
    }
  };
  // Administrator: bring in state.json from the WiFi website (log-ins are not copied)
  window.HE_IMPORT = sb ? async data => {
    const d = Object.assign({}, data); delete d.auth; delete d._seeded;
    const { error } = await sb.from('shop_state').upsert({ id: 'main', data: d });
    if (error) throw new Error(error.message);
    lastV = 0; await refresh();
  } : null;

  /* ---------- job photos (Supabase Storage, bucket "photos") ---------- */
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
  window.HE_BLOB = id => sb ? sb.storage.from('photos').getPublicUrl(id).data.publicUrl : '';
  const assets = {
    async upload(blob, opt) {
      const type = (opt && opt.type) || blob.type || 'image/jpeg', id = uid() + (EXT[type] || '');
      const { error } = await sb.storage.from('photos').upload(id, blob, { contentType: type, upsert: false, cacheControl: '31536000' });
      if (error) throw { code: 'upstream_error', message: error.message };
      return { id };
    },
    async delete(id) { await sb.storage.from('photos').remove([id]); return { ok: true }; },
    async list() { return { assets: [], usage: {} }; }
  };

  /* ---------- Excel downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const b = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(b), a = document.createElement('a');
      a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 10000);
      return { status: 'saved' };
    }
  };

  window.claude = { use: async n => (n === 'db' ? (sb ? db : null) : n === 'assets' ? (sb ? assets : null) : n === 'downloads' ? downloads : null) };
})();
