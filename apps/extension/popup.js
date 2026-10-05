// Окно расширения: состояние из фона (bg.js), действия - сообщениями ему.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let editing = false;
let ownDirty = false;
function render(st, update, current) {
  $('update').hidden = !update;
  if (update) $('updTitle').textContent = `Доступна версия ${update.version} (у вас ${current})`;
  const servers = st.sub && !st.sub.suspended ? st.sub.servers || [] : [];
  const setup = !st.subUrl || editing;
  $('setup').hidden = !setup;
  $('cancel').hidden = !st.subUrl;
  $('main').hidden = setup || !st.sub;
  $('foot').hidden = !st.subUrl;
  $('error').hidden = !st.error;
  $('error').textContent = st.error || '';
  $('updated').textContent = st.fetchedAt ? `Обновлено ${when(st.fetchedAt)}` : '';
  if (!st.sub) return;
  $('sub').textContent = st.sub.name || '';
  $('on').checked = st.enabled;
  $('on').disabled = !servers.length;
  const on = st.enabled && servers.length;
  $('state').textContent = on ? 'Включено' : 'Выключено';
  $('state').className = `state${on ? ' on' : ''}`;
  view = { servers, selected: servers.some((s) => s.id === st.server) ? st.server : 'auto' };
  renderServers();
  $('ru').checked = st.ruDirect;
  // свои адреса: пока человек правит список, повторная отрисовка его не затирает
  if (!ownDirty) $('ownText').value = st.directText || '';
  const n = parseDirect(st.directText || '').count;
  $('ownCount').textContent = n ? `(${n})` : '';
  const c = st.check;
  $('check').textContent = !on
    ? ''
    : !c
      ? ''
      : c.ok
        ? `Работает, ответ за ${c.ms} мс`
        : `Не работает: ${c.error || 'нет ответа'}`;
  $('test').hidden = !on;
}

// Список серверов: свой раскрывающийся список (у select нет колонки справа) - имя слева, пинг
// справа. Пинг замеряется при раскрытии списка (не чаще раза в 20 секунд).
let view = { servers: [], selected: 'auto' };
let pings = {};
let pingedAt = 0;
let measuring = false;

function pingText(id) {
  if (!(id in pings)) return measuring ? '...' : '';
  const ms = pings[id];
  return ms === null ? 'нет ответа' : `${ms} мс`;
}
function pingClass(id) {
  if (!(id in pings) || pings[id] === undefined) return 'ping';
  const ms = pings[id];
  return `ping ${ms === null ? 'bad' : ms < 150 ? 'good' : ms < 400 ? 'mid' : 'bad'}`;
}

function renderServers() {
  const { servers, selected } = view;
  const title = (id) =>
    id === 'auto'
      ? servers.length > 1
        ? 'Авто (остальные - запасные)'
        : 'Авто'
      : (servers.find((s) => s.id === id) || {}).title || id;
  $('ddLabel').textContent = title(selected);
  $('ddPing').textContent = selected === 'auto' ? '' : pingText(selected);
  $('ddPing').className = selected === 'auto' ? 'ping' : pingClass(selected);
  const list = $('ddList');
  list.textContent = '';
  for (const id of ['auto', ...servers.map((s) => s.id)]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ddopt${id === selected ? ' sel' : ''}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(id === selected));
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = title(id);
    const p = document.createElement('span');
    p.className = id === 'auto' ? 'ping' : pingClass(id);
    p.textContent = id === 'auto' ? '' : pingText(id);
    b.append(name, p);
    b.addEventListener('click', () => choose(id));
    list.append(b);
  }
}

function setOpen(open) {
  $('ddList').hidden = !open;
  $('ddBtn').setAttribute('aria-expanded', String(open));
  if (open && !measuring && Date.now() - pingedAt > 20_000) measure();
}

async function measure() {
  measuring = true;
  pings = {};
  renderServers();
  const r = await send({ cmd: 'pings' });
  measuring = false;
  pingedAt = Date.now();
  pings = (r && r.pings) || {};
  renderServers();
}

async function choose(id) {
  setOpen(false);
  if (id === view.selected) return;
  // выбор виден сразу, применение (с прогревом пароля) - в фоне
  view.selected = id;
  renderServers();
  await act({ cmd: 'server', id });
  act({ cmd: 'check' });
}

async function act(msg) {
  const r = await send(msg);
  if (r && r.error) {
    $('error').hidden = false;
    $('error').textContent = r.error;
  }
  if (r && r.state) render(r.state, r.update, r.current);
  return r;
}

$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  const r = await act({ cmd: 'setLink', link: $('link').value });
  $('save').disabled = false;
  if (r && !r.error) {
    editing = false;
    $('link').value = '';
    render(r.state, r.update, r.current);
    act({ cmd: 'check' });
  }
});
$('cancel').addEventListener('click', () => {
  editing = false;
  act({ cmd: 'state' });
});
$('change').addEventListener('click', () => {
  editing = true;
  act({ cmd: 'state' });
});
$('updDownload').addEventListener('click', () => act({ cmd: 'download' }));
$('updRestart').addEventListener('click', async () => {
  await send({ cmd: 'restart' });
  window.close();
});
$('on').addEventListener('change', async (e) => {
  await act({ cmd: 'toggle', on: e.target.checked });
  if (e.target.checked) act({ cmd: 'check' });
});
$('ddBtn').addEventListener('click', () => setOpen($('ddList').hidden));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('ddList').hidden) {
    e.preventDefault();
    setOpen(false);
    $('ddBtn').focus();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dd')) setOpen(false);
});
$('ru').addEventListener('change', (e) => act({ cmd: 'ru', on: e.target.checked }));
$('refresh').addEventListener('click', () => act({ cmd: 'refresh' }));
$('ownText').addEventListener('input', () => {
  ownDirty = true;
  $('ownSaved').textContent = '';
});
$('ownSave').addEventListener('click', async () => {
  const r = await send({ cmd: 'direct', text: $('ownText').value });
  const errs = (r && r.directErrors) || (r && r.error ? [r.error] : []);
  $('ownErr').hidden = !errs.length;
  $('ownErr').textContent = errs.join('\n');
  if (!errs.length && r && !r.error) {
    ownDirty = false;
    $('ownSaved').textContent = r.directSaved ? `Сохранено: ${r.directSaved}` : 'Список пуст';
    render(r.state, r.update, r.current);
  }
});
$('test').addEventListener('click', () => {
  $('check').textContent = 'Проверяю...';
  act({ cmd: 'check' });
});

(async () => {
  const r = await act({ cmd: 'state' });
  // подписка старше 5 минут - обновить: так и новая версия расширения видна сразу
  const age = Date.now() - Date.parse(r.state.fetchedAt || 0);
  if (r.state.subUrl && !(age < 5 * 60_000)) await act({ cmd: 'refresh' });
  if (r.state.enabled) act({ cmd: 'check' });
})();
