const CACHE_NAME = 'te-v9';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Force clear ALL old caches
  event.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
    )).then(() => self.clients.claim())
  );
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Background periodic sync for reminders
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkAndNotify());
  }
});

// Also check on regular sync
self.addEventListener('sync', event => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(checkAndNotify());
  }
});

// Manual trigger from app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_REMINDERS') {
    checkAndNotify();
  }
  if (event.data && event.data.type === 'STORE_DATA') {
    // Store reminder data in IndexedDB for background checks
    storeReminderData(event.data.payload);
  }
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type: 'window'}).then(cls => {
      if (cls.length > 0) {
        cls[0].focus();
      } else {
        clients.openWindow('./');
      }
    })
  );
});

// IndexedDB helpers for storing data in SW
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('te_reminders', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('data', {keyPath: 'id'});
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function storeReminderData(data) {
  try {
    const db = await openDB();
    const tx = db.transaction('data', 'readwrite');
    tx.objectStore('data').put({id: 'reminders', ...data, updatedAt: Date.now()});
  } catch(e) { console.log('SW store error', e); }
}

async function getReminderData() {
  try {
    const db = await openDB();
    const tx = db.transaction('data', 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore('data').get('reminders');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch(e) { return null; }
}

async function checkAndNotify() {
  const data = await getReminderData();
  if (!data) return;
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastNotif = data.lastNotifDate || '';
  const todayStr = today.toISOString().split('T')[0];
  
  // Only notify once per day
  if (lastNotif === todayStr) return;
  
  const reminders = [];
  const cur = data.currency || '\u20B9';
  const fmt = n => cur + Number(n || 0).toLocaleString('en-IN');
  
  // Check Credit Cards
  (data.creditCards || []).forEach(c => {
    if (c.isPaid || c.ccStatus === 'minPaid' || c.ccStatus === 'paid' || !c.dueDate) return;
    const totalPaid = (c.payments || []).reduce((s, x) => s + Number(x.amount), 0);
    if (c.ccStatus === 'partial' && totalPaid >= Number(c.minimumDue || 0)) return;
    const due = new Date(c.dueDate);
    const dd = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const diff = Math.ceil((dd - today) / (1e3 * 60 * 60 * 24));
    const name = c.cardName || ('****' + (c.cardNumber || '').slice(-4));
    
    if (diff === 3) reminders.push({title: 'CC Due in 3 Days', body: name + ' - Min Due: ' + fmt(c.minimumDue) + ' due ' + due.toLocaleDateString('en-IN', {day:'2-digit',month:'short'})});
    if (diff === 2) reminders.push({title: 'CC Due in 2 Days', body: name + ' - Min Due: ' + fmt(c.minimumDue) + ' due ' + due.toLocaleDateString('en-IN', {day:'2-digit',month:'short'})});
    if (diff === 1) reminders.push({title: 'CC Due Tomorrow!', body: name + ' - Min Due: ' + fmt(c.minimumDue)});
    if (diff === 0) reminders.push({title: 'CC Due Today!', body: name + ' - ' + fmt(c.minimumDue) + ' - Pay now!'});
    if (diff < 0 && diff >= -3) reminders.push({title: 'CC Overdue!', body: name + ' was due ' + Math.abs(diff) + ' day(s) ago'});
  });
  
  // Check EMIs
  (data.emis || []).forEach(em => {
    const emiDay = em.emiDate ? new Date(em.emiDate).getDate() : em.startDate ? new Date(em.startDate).getDate() : null;
    if (!emiDay) return;
    const entry = (em.entries || []).find(en => en.mo === now.getMonth() && en.yr === now.getFullYear());
    if (entry && entry.paid) return;
    
    const thisMonthDue = new Date(now.getFullYear(), now.getMonth(), emiDay);
    const diff = Math.ceil((thisMonthDue - today) / (1e3 * 60 * 60 * 24));
    
    if (diff === 3) reminders.push({title: 'EMI Due in 3 Days', body: em.name + ' - ' + fmt(em.amount) + ' due ' + thisMonthDue.toLocaleDateString('en-IN', {day:'2-digit',month:'short'})});
    if (diff === 2) reminders.push({title: 'EMI Due in 2 Days', body: em.name + ' - ' + fmt(em.amount) + ' due ' + thisMonthDue.toLocaleDateString('en-IN', {day:'2-digit',month:'short'})});
    if (diff === 1) reminders.push({title: 'EMI Due Tomorrow!', body: em.name + ' - ' + fmt(em.amount)});
    if (diff === 0) reminders.push({title: 'EMI Due Today!', body: em.name + ' - ' + fmt(em.amount) + ' - Pay now!'});
  });
  
  // Send notifications
  for (let i = 0; i < reminders.length; i++) {
    await self.registration.showNotification(reminders[i].title, {
      body: reminders[i].body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'reminder-' + i,
      renotify: true,
      requireInteraction: true
    });
  }
  
  // Mark as notified today
  if (reminders.length > 0) {
    await storeReminderData({...data, lastNotifDate: todayStr});
  }
}