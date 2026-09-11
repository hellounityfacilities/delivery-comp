// Shared helpers: API client, auth, i18n, socket, toast
const API = location.origin + '/api';
const S = { token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || 'null'), lang: localStorage.getItem('lang') || 'en' };
async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401 && S.token) { logout(); } throw new Error(data.error || 'Request failed'); }
  return data;
}
function setSession(token, user) { S.token = token; S.user = user; localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); }
function logout() { localStorage.removeItem('token'); localStorage.removeItem('user'); location.reload(); }
function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); }
const fmt = n => 'QAR ' + Number(n || 0).toFixed(2);
const ago = d => { const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : Math.round(m / 60) + 'h'; };
const STATUS = { placed: 'Placed', awaiting_approval: 'Awaiting approval', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready', picked_up: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', rider_assigned: 'Rider assigned', rider_unassigned: 'Rider reassigned' };
const STATUS_AR = { placed: 'تم الطلب', awaiting_approval: 'بانتظار الموافقة', accepted: 'تم القبول', preparing: 'قيد التحضير', ready: 'جاهز', picked_up: 'في الطريق', delivered: 'تم التوصيل', cancelled: 'ملغي', refunded: 'مسترد', rider_assigned: 'تم تعيين مندوب', rider_unassigned: 'إعادة تعيين المندوب' };
const statusLabel = s => (S.lang === 'ar' ? STATUS_AR[s] : STATUS[s]) || s;
const pillClass = s => ({ delivered: 'ok', cancelled: 'warn', refunded: 'warn', picked_up: 'maroon', ready: 'maroon' })[s] || '';
function t(en, ar) { return S.lang === 'ar' && ar ? ar : en; }
function setLang(l) { S.lang = l; localStorage.setItem('lang', l); document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr'; }
setLang(S.lang);
function connectSocket(handlers) {
  if (!S.token || !window.io) return null;
  const s = io(location.origin, { auth: { token: S.token } });
  for (const [ev, fn] of Object.entries(handlers)) s.on(ev, fn);
  return s;
}
// Phone-OTP sign in UI, shared by all apps. Resolves when signed in.
function renderLogin(root, { title, subtitle, allowRoles }) {
  return new Promise(resolve => {
    let phone = '';
    const draw = (step, devCode) => {
      root.innerHTML = `<div style="max-width:420px;margin:60px auto;padding:0 16px">
        <h1 class="h1">${title}</h1><p class="muted" style="margin-bottom:24px">${subtitle}</p>
        <div class="card">
        ${step === 1 ? `<div class="field"><label>${t('Mobile number', 'رقم الجوال')}</label><input id="ph" type="tel" placeholder="+974 5xxx xxxx" value="${phone}"></div>
          <button class="btn block" id="go">${t('Send code', 'إرسال الرمز')}</button>`
        : `<p class="muted">${t('Code sent to', 'تم إرسال الرمز إلى')} ${phone}${devCode ? ` <span class="pill">dev: ${devCode}</span>` : ''}</p>
          <div class="field"><label>${t('Verification code', 'رمز التحقق')}</label><input id="code" inputmode="numeric" maxlength="6" value="${devCode || ''}"></div>
          <div class="field"><label>${t('Your name (new accounts)', 'الاسم')}</label><input id="nm"></div>
          <button class="btn block" id="go">${t('Sign in', 'تسجيل الدخول')}</button><button class="btn ghost block" style="margin-top:8px" id="back">${t('Change number', 'تغيير الرقم')}</button>`}
        </div>
        <p class="muted" style="text-align:center;margin-top:16px"><button id="lang">${S.lang === 'ar' ? 'English' : 'العربية'}</button></p></div>`;
      root.querySelector('#lang').onclick = () => { setLang(S.lang === 'ar' ? 'en' : 'ar'); draw(step, devCode); };
      const back = root.querySelector('#back'); if (back) back.onclick = () => draw(1);
      root.querySelector('#go').onclick = async () => {
        try {
          if (step === 1) { phone = root.querySelector('#ph').value.trim(); const r = await api('/auth/otp', { method: 'POST', body: { phone } }); draw(2, r.dev_code); root.querySelector('#code').focus(); }
          else {
            const r = await api('/auth/verify', { method: 'POST', body: { phone, code: root.querySelector('#code').value.trim(), name: root.querySelector('#nm').value.trim() || undefined } });
            if (allowRoles && !allowRoles.includes(r.user.role) && r.user.role !== 'admin') return toast(t('This account cannot use this app', 'هذا الحساب لا يمكنه استخدام هذا التطبيق'), true);
            setSession(r.token, r.user); resolve(r.user);
          }
        } catch (e) { toast(e.message, true); }
      };
      const inp = root.querySelector('input'); inp.focus(); inp.onkeydown = e => { if (e.key === 'Enter') root.querySelector('#go').click(); };
    };
    draw(1);
  });
}
