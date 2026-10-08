/* الخلفيات المتحركة: فيديو شاشة الدخول، وفيديو التطبيق، وخلفية النجوم (glitter.js) بديلًا
 * لكلٍّ منهما. الفيديو يُحمَّل عند الحاجة فقط ويحفظه المتصفح بعد أول مرة، ولا يُحمَّل مع
 * «توفير البيانات» أو الاتصال البطيء جدًّا؛ وإن تعذّر حلّت محلّه النجوم. لكلٍّ منهما زرٌّ يوقفه
 * ويشغّله، والاختيار يُحفظ في المتصفح. يستدعيها js/session.js عند الدخول والخروج والصيانة،
 * وتُربط أزرارها من wireEvents (js/main.js). */
'use strict';

/* ============================ النجوم ============================ */

/* كاملة في شاشة الدخول، وخفيفة داخل التطبيق؛ وواحدةٌ فقط تعمل في كل وقت */
let glitterStop = null;
function stopGlitter() {
  if (glitterStop) { try { glitterStop(); } catch {} glitterStop = null; }
}
function startLoginGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  try { glitterStop = Glitter.mount($('#loginScreen'), { color2: state.themeAccent }); } catch {}
}
function startAppGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  const el = $('#appGlitter');
  if (!el) return;
  try {
    glitterStop = Glitter.mount(el, { particleCount: 90, brightness: 40, trailAmount: 78, starSize: 9, speed: 2.5, glitterIntensity: 2, maxDpr: 1, color2: state.themeAccent });
  } catch {}
}

/* ============================ أدوات الفيديو ============================ */

const bgVideoAllowed = () => {
  const c = navigator.connection;
  return !(c && (c.saveData || /2g$/.test(c.effectiveType || '')));
};
/** يبدأ تحميل ملف الفيديو مرّةً واحدة؛ false إن سبق أن تعذّر */
function attachBgVideo(v, onFail) {
  if (v.dataset.failed) return false;
  if (!v.getAttribute('src')) {
    v.addEventListener('error', () => { v.dataset.failed = '1'; onFail(); }, { once: true });
    v.preload = 'auto';
    v.src = v.dataset.src;
  }
  return true;
}
/** اختيار «أوقفه» محفوظٌ في المتصفح ('1' = موقوف) */
const prefOff = (key) => lsGet(key) === '1';
const savePref = (key, on) => lsSet(key, on ? '0' : '1');

/* ============================ شاشة الدخول ============================ */

/* فيديو (نحو 7.6 ميغابايت) وزرٌّ صغير في الركن يوقفه */
const LOGIN_VIDEO_OFF_KEY = 'p2pLoginVideoOff';
let loginVideoOn = false;   // ما اختاره المستخدم (المتصفح يوقفه وحده حين تُخفى الصفحة)
function setLoginVideo(on) {
  const v = $('#loginVideo'), btn = $('#btnLoginVideo');
  loginVideoOn = on;
  if (on) v.play().catch(() => {});
  else v.pause();
  const label = on ? 'إيقاف الفيديو' : 'تشغيل الفيديو';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = '';
  btn.append(svgIcon(on ? 'pause' : 'play'));
}
function toggleLoginVideo() {
  setLoginVideo(!loginVideoOn);
  savePref(LOGIN_VIDEO_OFF_KEY, loginVideoOn);
}
function startLoginBackground() {
  stopGlitter();
  stopAppBackground();
  const v = $('#loginVideo');
  const screen = $('#loginScreen');
  const fail = () => { screen.classList.remove('has-video'); $('#btnLoginVideo').classList.add('hidden'); startLoginGlitter(); };
  if (!v || !bgVideoAllowed() || !attachBgVideo(v, fail)) { fail(); return; }
  screen.classList.add('has-video');
  $('#btnLoginVideo').classList.remove('hidden');
  setLoginVideo(!prefOff(LOGIN_VIDEO_OFF_KEY));
}
function stopLoginBackground() {
  const v = $('#loginVideo');
  if (v) v.pause();   // لا يعمل الفيديو خلف التطبيق وهو مخفي
  loginVideoOn = false;
}

/* ============================ داخل التطبيق ============================ */

/* فيديو بثٍّ (HLS من Mux) على الشاشات العريضة وحدها — على الهاتف النجوم توفيرًا للبيانات —
   وفوقه تظليلٌ يُبقي الأرقام واضحة؛ وبندٌ في القائمة يوقفه. Safari يشغّل HLS بنفسه؛ وغيره
   يحتاج hls.js، فتُحمَّل عند الحاجة فقط من jsDelivr بنسخةٍ ثابتة ومعها بصمتها (integrity) فلا
   يُنفَّذ إلا الملف نفسه. والجودة محدودة بـ720p فلا تُهدر البيانات. */
const APP_VIDEO_OFF_KEY = 'p2pAppVideoOff';
const HLS_JS = {
  src: 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.light.min.js',
  integrity: 'sha256-AlEzLACiFqNdfWkZBE1g2oK3i+s71QrGxmKudKL1R0s=',
};
let appVideoOn = false;
let hlsLib = null;   // وعدٌ واحد بتحميل المكتبة
function loadHlsLib() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLib) {
    hlsLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_JS.src;
      s.integrity = HLS_JS.integrity;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js')));
      s.onerror = () => { hlsLib = null; reject(new Error('hls.js')); };
      document.head.append(s);
    });
  }
  return hlsLib;
}
/** يربط البثّ بعنصر الفيديو مرّةً واحدة؛ false إن تعذّر (فتعود النجوم).
    hls.js أولًا حيث يتوفّر MSE (Chrome يدّعي أحيانًا دعم HLS ثم يفشل)، والتشغيل المباشر لما لا MSE فيه (iPhone) */
async function attachAppStream(v, onFail) {
  if (v.dataset.failed) return false;
  if (v.dataset.attached) return true;
  v.dataset.attached = '1';
  const fail = () => { v.dataset.failed = '1'; onFail(); };
  if (window.MediaSource || window.ManagedMediaSource) {
    try {
      const Hls = await loadHlsLib();
      if (Hls.isSupported()) {
        const hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 20 });
        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
          // أعلى جودةٍ لا تتجاوز 720p: خلفيةٌ مغبّشة تحت تظليل لا تحتاج أكثر
          let cap = -1;
          data.levels.forEach((l, i) => { if (l.height <= 720 && (cap < 0 || l.height > data.levels[cap].height)) cap = i; });
          if (cap >= 0) hls.autoLevelCapping = cap;
        });
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); fail(); } });
        hls.loadSource(v.dataset.src);
        hls.attachMedia(v);
        return true;
      }
    } catch {}
  }
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.addEventListener('error', fail, { once: true });
    v.src = v.dataset.src;
    return true;
  }
  fail();
  return false;
}
const appVideoPossible = () => {
  const v = $('#appVideo');
  return !!v && !v.dataset.failed && bgVideoAllowed() && window.matchMedia('(min-width: 900px)').matches;
};
/** بند القائمة: يظهر حيث يمكن الفيديو، ونصّه وأيقونته بحسب حاله */
function syncAppVideoItem() {
  const b = $('#btnAppVideo');
  if (!b) return;
  b.closest('.menu-group').classList.toggle('hidden', !appVideoPossible());
  b.textContent = '';
  b.append(svgIcon(appVideoOn ? 'pause' : 'play'), appVideoOn ? 'إيقاف خلفية الفيديو' : 'تشغيل خلفية الفيديو');
}
function appBackgroundFallback() {
  $('#app').classList.remove('has-video');
  const v = $('#appVideo');
  if (v) v.pause();
  appVideoOn = false;
  startAppGlitter();
  syncAppVideoItem();
}
async function startAppBackground() {
  stopGlitter();
  const v = $('#appVideo');
  if (!appVideoPossible() || prefOff(APP_VIDEO_OFF_KEY)) { appBackgroundFallback(); return; }
  $('#app').classList.add('has-video');
  appVideoOn = true;
  syncAppVideoItem();
  if (await attachAppStream(v, appBackgroundFallback) && appVideoOn) v.play().catch(() => {});
}
function stopAppBackground() {
  const v = $('#appVideo');
  if (v) v.pause();
  appVideoOn = false;
}
function toggleAppVideo() {
  savePref(APP_VIDEO_OFF_KEY, !appVideoOn);
  if (appVideoOn) appBackgroundFallback(); else startAppBackground();
}
/** بعد تغيير حجم النافذة: الفيديو للشاشات العريضة وحدها، فتحلّ محلّه النجوم حين تضيق،
    ويعود حين تتّسع (إلا إن أوقفه المستخدم) */
function fitAppBackground() {
  if ($('#app').classList.contains('hidden')) return;
  if (appVideoOn && !appVideoPossible()) appBackgroundFallback();
  else if (!appVideoOn && appVideoPossible() && !prefOff(APP_VIDEO_OFF_KEY)) startAppBackground();
  else syncAppVideoItem();
}

/* ============================ ربط الأزرار ============================ */

function wireBackgrounds() {
  $('#btnLoginVideo').addEventListener('click', toggleLoginVideo);
  // بندٌ في القائمة: يغلقها ثم يبدّل (closeMenu في js/main.js)
  $('#btnAppVideo').addEventListener('click', () => { closeMenu(); toggleAppVideo(); });
  // عند العودة إلى الصفحة يُستأنف الفيديو الظاهر إن كان شغّالًا (المتصفح يوقفه حين تُخفى)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const s = $('#loginScreen');
    if (loginVideoOn && s.classList.contains('has-video') && !s.classList.contains('hidden')) $('#loginVideo').play().catch(() => {});
    if (appVideoOn && !$('#app').classList.contains('hidden')) $('#appVideo').play().catch(() => {});
  });
}
