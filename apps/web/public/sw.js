// Service worker панели: нужен для установки как приложения. Ничего не кэширует:
// панель показывает живые данные, а после выкладки не должна отдавать старый интерфейс.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
