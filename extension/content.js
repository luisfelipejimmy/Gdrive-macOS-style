// GDrive macOS style — content script
// Visualização em colunas (estilo Finder) para o Google Drive, sem API e sem credenciais:
// lê os itens da própria lista do Drive e repassa seleção, menus e atalhos para a lista nativa,
// que continua existindo (escondida) embaixo das colunas.
(() => {
  'use strict';
  if (window.top !== window || window.__gdfLoaded) return;
  window.__gdfLoaded = true;

  // Permite testar fora da extensão com um armazenamento simulado.
  const EXT = globalThis.__GDF_EXT__ || (typeof chrome !== 'undefined' ? chrome : null);
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  // Autoteste pedido pela URL (…/drive/my-drive#gdf-teste). Lido já no document_start, antes do Drive mexer na URL.
  const TEST_HASH = /^#gdf-teste\b/;
  const WANT_TEST = TEST_HASH.test(location.hash);

  // ================================================================ constantes

  const DEFAULT_COL_W = 260;
  const MIN_COL_W = 160;
  const MAX_COL_W = 640;
  const FOLDER_RE = /^(pasta|folder|shared folder|carpeta|dossier|ordner|freigegebener ordner|cartella|drive compartilhado|shared drive|unidade compartilhada|computador|computer|ordenador|ordinateur)\b/i;
  const SHORTCUT_RE = /\b(atalho|shortcut|acceso directo|raccourci|verknüpfung|scorciatoia)\b/i;
  const SHARED_RE = /\s+(compartilhad[oa]|shared|compartido|partagé|freigegeben|condiviso)$/i;
  const SUPPORTED_RE = /^\/drive\/(my-drive|folders\/[\w-]+|shared-with-me|recent|starred|trash|shared-drives|computers|search)\b/;

  const ICONS = {
    chevron: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    file: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    folder: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    open: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  };

  // ================================================================ estado

  const S = {
    enabled: false,
    key: null, // chave da rota atual (/drive/...)
    needsBuild: true,
    initialBuild: false, // a próxima construção é a da carga da página por URL (só ela usa pathMode)
    lastHref: '',
    expectKey: null, // navegação iniciada pela extensão
    cols: [],
    active: 0,
    preview: null, // item | { multi: item[] }
    buildSeq: 0,
    recSeq: 0,
    userTouched: false,
    colW: DEFAULT_COL_W,
    pathMode: 'folder', // 'folder' | 'full' (página de opções da extensão)
    cache: new Map(), // chave da pasta -> itens
    typeBuf: '',
    typeT: 0,
    wantFocus: false,
    dark: false,
    bg: '',
    toggleCls: null,
    ignoreNativeClick: false,
    nat: { key: null, settled: false, prevSig: '', since: 0, emptySince: 0, complete: false, stall: 0, lastCount: -1, nextMoreAt: 0 },
    lastSig: '',
    nativeDirty: true,
    mainObs: null,
    observedMain: null,
    broken: null, // { id, msg, detail } quando a proteção desligou as colunas
    drag: null, // itens sendo arrastados nas colunas: { srcKey, ids, items }
    dropT: null, // alvo destacado durante o arraste: { col, item, row, key }
    spring: { id: null, t: 0 },
    prefetch: { key: null, t: 0 },
    busy: false, // movendo itens pela janela "Mover" do Drive
    moving: new Set(), // ids sendo movidos (aparecem esmaecidos)
    natDrop: null, // lista nativa que já recebeu o dragenter de arquivos: { key, el, dt }
    rootId: null, // id da pasta "Meu Drive" (vem do breadcrumb)
  };
  const ui = { root: null, strip: null, layer: null, preview: null, previewKey: '' };

  // ================================================================ utilidades

  const NS = 'http://www.w3.org/2000/svg';
  function icon(name, size = 20) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name]);
    p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }
  function columnsIcon() {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 14 12');
    s.setAttribute('width', '14');
    s.setAttribute('height', '12');
    s.setAttribute('fill', 'none');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('fill-rule', 'evenodd');
    p.setAttribute('d', 'M1.5 0h11A1.5 1.5 0 0 1 14 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 0 10.5v-9A1.5 1.5 0 0 1 1.5 0zM1.5 1.5v9h3v-9zM5.5 1.5v9h3v-9zM9.5 1.5v9h3v-9z');
    s.append(p);
    return s;
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const plural = (n, one, many) => (n === 1 ? one : many.replace('#', n));

  // ================================================================ rotas

  function curKey() {
    const p = location.pathname.replace(/^\/drive\/u\/\d+/, '/drive').replace(/\/+$/, '');
    const m = p.match(/^\/drive\/folders\/([\w-]+)/);
    if (m) return '/drive/folders/' + m[1];
    if (p.startsWith('/drive/search')) return p + location.search;
    return p;
  }
  const isSupported = (key) => !!key && SUPPORTED_RE.test(key);
  const isFolderKey = (key) => /^\/drive\/(my-drive|folders\/)/.test(key || '');
  // Em Computadores o Drive não usa a tabela: cada computador é um card (div[role=gridcell]).
  const COMPUTERS_KEY = '/drive/computers';
  const ROW_SEL = 'tr[role="row"][data-id]';
  const CARD_SEL = 'div[role="gridcell"][data-id]';
  const itemSel = () => (curKey() === COMPUTERS_KEY ? CARD_SEL : ROW_SEL);
  const keyForId = (id) => '/drive/folders/' + id;
  function folderIdOf(key) {
    const m = (key || '').match(/^\/drive\/folders\/([\w-]+)/);
    return m ? m[1] : key === '/drive/my-drive' ? S.rootId : null;
  }
  function authuser() {
    const m = location.pathname.match(/^\/drive\/u\/(\d+)/);
    return m ? m[1] : '0';
  }
  function fullPath(key) {
    const prefix = (location.pathname.match(/^\/drive\/u\/\d+/) || ['/drive'])[0];
    return prefix + key.slice('/drive'.length);
  }
  // Navega o Drive (SPA) sem recarregar e sem poluir o histórico.
  function navigateDrive(key) {
    if (curKey() === key) return;
    S.lastSig = nativeSig();
    S.expectKey = key;
    history.replaceState(history.state, '', fullPath(key));
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    natCheckKey();
  }
  function pageTitle() {
    return (document.title || '').replace(/\s+-\s+Google Drive\s*$/, '').trim();
  }

  // ================================================================ leitura da lista nativa

  function findMain() {
    let best = null;
    let area = 0;
    for (const m of document.querySelectorAll('div[role="main"]')) {
      const r = m.getBoundingClientRect();
      const a = r.width * r.height;
      if (r.width > 200 && r.height > 100 && a > area) {
        best = m;
        area = a;
      }
    }
    return best;
  }
  function nativeGrid(main = findMain()) {
    return main ? main.querySelector('[role="grid"]') : null;
  }
  function nativeRows(grid = nativeGrid()) {
    return grid ? [...grid.querySelectorAll(itemSel())] : [];
  }
  function rowById(id) {
    const g = nativeGrid();
    return g ? g.querySelector(`${itemSel()}[data-id="${CSS.escape(id)}"]`) : null;
  }
  const isCard = (el) => el.tagName !== 'TR';
  function nativeSig(rows = nativeRows()) {
    return rows.map((r) => r.getAttribute('data-id')).join(',');
  }
  function nativeHeads(grid) {
    // A primeira linha sem data-id com várias células é o cabeçalho (em "Recentes" há linhas de seção).
    const hr = grid && [...grid.querySelectorAll('tr:not([data-id])')].find((r) => r.children.length >= 3);
    return hr ? [...hr.children].map((c) => c.textContent.trim()) : [];
  }
  function nativeScroller(grid) {
    let e = grid;
    while (e && e !== document.body) {
      if (e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
      e = e.parentElement;
    }
    return null;
  }
  function firstText(el) {
    if (!el) return '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue.trim();
      if (t) return t;
    }
    return '';
  }
  function cloneIcon(tr) {
    const cell = isCard(tr) ? tr : tr.querySelector('td');
    const src = cell && (cell.querySelector('svg') || cell.querySelector('img'));
    if (!src) return null;
    const node = src.cloneNode(true);
    node.removeAttribute('width');
    node.removeAttribute('height');
    node.style.color = getComputedStyle(src).color;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  // Lê as linhas nativas. Reaproveita objetos já conhecidos para não clonar ícones toda vez.
  function scrapeItems(rows, heads, prev) {
    const known = new Map((prev || []).map((i) => [i.id, i]));
    return rows.map((tr) => {
      const id = tr.getAttribute('data-id');
      const card = isCard(tr);
      const name = card ? firstText(tr) : (tr.querySelector('strong') || {}).textContent || '';
      const label = card ? cardLabel(tr, name) : (tr.querySelector('td [aria-label]') || { getAttribute: () => '' }).getAttribute('aria-label') || '';
      const rawType = label.startsWith(name) ? label.slice(name.length).trim() : label;
      const old = known.get(id);
      if (old && old.name === name && old.rawType === rawType) {
        old.info = rowInfo(tr, heads) || old.info;
        return old;
      }
      const shared = SHARED_RE.test(rawType);
      const type = rawType.replace(SHARED_RE, '').trim();
      return {
        id,
        name,
        rawType,
        type,
        shared,
        // Em Computadores todo card é um computador, que abre como pasta.
        isFolder: card || FOLDER_RE.test(type) || (SHORTCUT_RE.test(type) && /(pasta|folder)/i.test(type)),
        isShortcut: SHORTCUT_RE.test(type),
        icon: cloneIcon(tr),
        info: rowInfo(tr, heads),
      };
    });
  }
  // Rótulo "Nome Tipo" do card (a dica do nome; o aria-label do card traz texto extra no fim).
  function cardLabel(el, name) {
    const tip = [...el.querySelectorAll('[data-tooltip]')].map((e) => e.getAttribute('data-tooltip')).find((t) => name && t.startsWith(name));
    return tip || el.getAttribute('aria-label') || '';
  }
  function rowInfo(tr, heads) {
    const cells = [...tr.children];
    const out = [];
    for (let k = 1; k < cells.length && k < heads.length; k++) {
      const head = heads[k];
      if (!head || /orden|sort|classif/i.test(head)) continue;
      const v = firstText(cells[k]);
      if (v) out.push([head, v]);
    }
    return out;
  }

  function scrapeCrumbs() {
    const main = findMain();
    if (!main) return [];
    const mr = main.getBoundingClientRect();
    // Pastas de um computador começam em "Computadores", que não tem data-id (só data-view="…computers…").
    const crumbs = [...document.querySelectorAll('[role="link"][data-id], [role="link"][data-view*="computers"]')]
      .filter((e) => {
        if (main.contains(e) || (ui.root && ui.root.contains(e))) return false;
        const b = e.getBoundingClientRect();
        return b.height > 0 && b.left >= mr.left - 4 && b.bottom <= mr.top + 2;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((e) => {
        const id = e.getAttribute('data-id');
        return { id, key: id ? keyForId(id) : COMPUTERS_KEY, name: e.textContent.trim() };
      });
    // "Computadores" só faz sentido como raiz do caminho.
    return crumbs.filter((c, i) => c.id || i === 0);
  }

  // ================================================================ sincronização com a lista nativa

  function natCheckKey() {
    const k = curKey();
    if (k === S.nat.key) return;
    S.nat = {
      key: k, settled: false, prevSig: S.lastSig, since: Date.now(), emptySince: 0,
      complete: false, stall: 0, lastCount: -1, nextMoreAt: 0, failed: false,
    };
    S.nativeDirty = true;
  }

  function observeMain(main) {
    if (S.observedMain === main) return;
    if (S.mainObs) S.mainObs.disconnect();
    S.observedMain = main;
    if (!main) return;
    S.mainObs = new MutationObserver(() => {
      S.nativeDirty = true;
      scheduleSync();
    });
    S.mainObs.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'data-id'] });
  }
  let syncT = 0;
  function scheduleSync() {
    if (syncT) return;
    syncT = setTimeout(guarded('sync', () => {
      syncT = 0;
      syncNative();
    }), 80);
  }

  function syncNative() {
    natCheckKey();
    const N = S.nat;
    const now = Date.now();
    const main = findMain();
    observeMain(main);
    const grid = nativeGrid(main);
    const rows = nativeRows(grid);
    const sig = nativeSig(rows);

    if (!N.settled) {
      if (sig && sig !== N.prevSig) {
        N.settled = true;
      } else if (!sig) {
        // Durante o carregamento a área fica vazia; pasta vazia mostra ilustração/texto.
        const hasContent = main && (main.innerText.trim() || main.querySelector('img, svg'));
        if (hasContent) {
          N.emptySince = N.emptySince || now;
          if (now - N.emptySince > 400) N.settled = true;
        } else N.emptySince = 0;
      }
      if (!N.settled && now - N.since > 10000) {
        N.settled = true;
        N.failed = !!sig && sig === N.prevSig;
      }
      if (N.settled) {
        S.nativeDirty = true;
        noteNav(!N.failed);
      }
    }
    S.lastSig = sig;
    if (!N.settled || !isShowing()) return;

    ensureListLayout(main, grid);
    if (N.failed) {
      const col = S.cols.find((c) => c.key === N.key);
      if (col && !col.items) {
        col.error = true;
        fillCol(col);
      }
      return;
    }
    if (S.nativeDirty) {
      S.nativeDirty = false;
      const col = S.cols.find((c) => c.key === N.key);
      const prev = col ? col.items : S.cache.get(N.key);
      let items = scrapeItems(rows, nativeHeads(grid), prev);
      if (!N.complete && prev && prev.length > items.length) {
        // Enquanto a lista nativa não terminou de paginar, mantém os itens já conhecidos.
        const seen = new Set(items.map((i) => i.id));
        items = items.concat(prev.filter((i) => !seen.has(i.id)));
      }
      S.cache.set(N.key, items);
      if (col) setItems(col, items, N.complete);
    }
    loadMore(grid, rows.length, now);
  }

  // Rola a lista nativa (escondida) para o Drive carregar as próximas páginas.
  function loadMore(grid, count, now) {
    const N = S.nat;
    if (N.complete || now < N.nextMoreAt) return;
    N.nextMoreAt = now + 900;
    if (count === N.lastCount) N.stall++;
    else N.stall = 0;
    N.lastCount = count;
    const sc = grid && nativeScroller(grid);
    if (!sc || N.stall >= 2) {
      N.complete = true;
      S.nativeDirty = true;
      const col = S.cols.find((c) => c.key === N.key);
      if (col) col.complete = true;
      scheduleSync();
      return;
    }
    sc.scrollTop = sc.scrollHeight;
  }

  async function waitSettled(key, isStale) {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (isStale && isStale()) return false;
      syncNative();
      if (S.nat.key === key && S.nat.settled) return !S.nat.failed;
      if (S.nat.key !== key && S.nat.settled && Date.now() - t0 > 1500 && S.expectKey !== key) return false;
      await sleep(60);
    }
    return false;
  }

  async function ensureNative(key, isStale) {
    if (curKey() !== key) navigateDrive(key);
    return waitSettled(key, isStale);
  }

  async function waitFor(fn, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    return null;
  }

  // Espera o breadcrumb do cabeçalho aparecer e ficar estável (mesmo resultado em leituras seguidas).
  // Devolve [] se estourar o tempo, ficar obsoleto ou o usuário mexer nas colunas.
  async function waitCrumbs(isStale, ms = 5000) {
    let prev = '';
    let same = 0;
    const found = await waitFor(() => {
      if (isStale() || S.userTouched) return [];
      const cr = scrapeCrumbs();
      const sig = cr.map((c) => c.id || 'computers').join('/');
      same = cr.length && sig === prev ? same + 1 : 0;
      prev = sig;
      return same >= 2 ? cr : null;
    }, ms);
    return found || [];
  }

  // Breadcrumb abreviado ("…"): sobe uma pasta por vez e lê o breadcrumb de novo, até chegar à raiz.
  // Cada passo revela as pastas que ficavam escondidas atrás do "…".
  async function expandCrumbs(crumbs, isStale) {
    let all = crumbs;
    const quit = () => isStale() || S.userTouched;
    for (let n = 0; n < 30 && !quit(); n++) {
      const first = all[0];
      if (!first?.id || (S.rootId && first.id === S.rootId)) break;
      if (!(await ensureNative(first.key, quit))) break;
      const up = await waitCrumbs(isStale, 2000);
      const seen = new Set(all.map((c) => c.id || 'computers'));
      const fresh = up.filter((c) => !seen.has(c.id || 'computers'));
      if (!fresh.length) {
        // Nada acima de "first". Em "Compartilhados comigo" e em Drives compartilhados isso também
        // acontece, então só guarda como raiz quando o Drive abriu mesmo o Meu Drive.
        if (!S.rootId && !quit() && curKey() === '/drive/my-drive') S.rootId = first.id;
        break;
      }
      all = [...fresh, ...all];
    }
    return all;
  }

  function ensureListLayout(main, grid) {
    if (!main || S.ignoreNativeClick || nativeRows(grid).length) return;
    if (!main.querySelector('[data-id]')) return;
    const list = document.querySelector('button[data-test-id="list-layout-button"]');
    if (!list) return;
    // Está no layout de grade: as colunas precisam do layout de lista por baixo.
    S.ignoreNativeClick = true;
    fire(list, 'mousedown');
    fire(list, 'mouseup');
    fire(list, 'click');
    S.ignoreNativeClick = false;
    const group = list.parentElement;
    for (const n of group.querySelectorAll(':scope > button[role="radio"]:not(.gdf-toggle)')) {
      n.dataset.gdfSaved = n === list ? 'true' : 'false';
    }
  }

  // ---------------------------------------------------------------- ações na lista nativa

  function fire(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window, composed: true,
      clientX: extra.clientX ?? r.left + Math.min(160, r.width / 2),
      clientY: extra.clientY ?? r.top + r.height / 2,
      button: extra.button || 0,
      buttons: extra.button === 2 ? 2 : 1,
      metaKey: !!extra.metaKey, ctrlKey: !!extra.ctrlKey, shiftKey: !!extra.shiftKey, altKey: !!extra.altKey,
      detail: extra.detail || 1,
    };
    S.firing = true;
    try {
      el.dispatchEvent(new MouseEvent(type, opts));
    } finally {
      S.firing = false;
    }
  }
  const rowTarget = (tr) => tr.querySelector('strong') || tr;
  const TOGGLE_MOD = IS_MAC ? { metaKey: true } : { ctrlKey: true };

  function nativeClick(tr, mods = {}) {
    const t = rowTarget(tr);
    const r = tr.getBoundingClientRect();
    // No card, clica perto do ícone (à direita fica o botão "Mais ações").
    const pos = { clientX: r.left + Math.min(isCard(tr) ? 40 : 200, r.width / 2), clientY: r.top + r.height / 2, ...mods };
    fire(t, 'mousedown', pos);
    fire(t, 'mouseup', pos);
    fire(t, 'click', pos);
  }

  function nativeSelected() {
    return nativeRows().filter((r) => r.getAttribute('aria-selected') === 'true');
  }

  async function applyNativeSelection(ids) {
    const want = new Set(ids);
    const cur = nativeSelected();
    if (cur.length === want.size && cur.every((r) => want.has(r.getAttribute('data-id')))) return true;
    if (!ids.length) {
      for (const r of cur) nativeClick(r, TOGGLE_MOD);
      return true;
    }
    const first = rowById(ids[0]);
    if (!first) return false;
    nativeClick(first);
    for (const id of ids.slice(1)) {
      const r = rowById(id);
      if (r) nativeClick(r, TOGGLE_MOD);
    }
    await sleep(30);
    return true;
  }

  // Leva a lista nativa para a pasta da coluna ativa e seleciona lá os mesmos itens.
  async function prepareNative() {
    // Um "mover" em andamento usa a seleção da lista nativa: espera ele terminar.
    if (S.busy && !(await waitFor(() => !S.busy, 20000))) return false;
    const my = ++S.recSeq;
    const c = S.cols[S.active];
    if (!c) return false;
    const ok = await ensureNative(c.key, () => my !== S.recSeq);
    if (!ok || my !== S.recSeq) return false;
    await applyNativeSelection([...c.sel]);
    return my === S.recSeq;
  }

  // Reflete a seleção das colunas na lista nativa (com pequeno atraso para não "brigar" com as setas).
  function reconcile() {
    const my = ++S.recSeq;
    setTimeout(guarded('reconcile', async () => {
      // Durante um "mover" a lista nativa está ocupada; no fim ele mesmo chama reconcile().
      if (my !== S.recSeq || !isShowing() || S.busy) return;
      const stale = () => my !== S.recSeq;
      const c = S.cols[S.active];
      if (!c) return;
      const sel = selItems(c);
      const next = S.cols[S.active + 1];
      if (sel.length === 1 && sel[0].isFolder && next) {
        if (next.pendingShortcut) return openShortcutColumn(c, sel[0], next, stale);
        await ensureNative(next.key, stale);
      } else {
        if (!(await ensureNative(c.key, stale)) || stale()) return;
        await applyNativeSelection(sel.map((i) => i.id));
      }
    }), 140);
  }

  // Atalho para pasta: o destino só é conhecido abrindo pelo próprio Drive.
  async function openShortcutColumn(c, item, next, stale) {
    if (!(await ensureNative(c.key, stale)) || stale()) return;
    const tr = rowById(item.id);
    if (!tr) return;
    const before = curKey();
    S.expectKey = '*';
    fire(rowTarget(tr), 'dblclick', { detail: 2 });
    const k = await waitFor(() => (curKey() !== before ? curKey() : null), 5000);
    if (!k || stale() || !S.cols.includes(next)) return;
    next.key = k;
    next.pendingShortcut = false;
    S.nativeDirty = true;
    await waitSettled(k, stale);
  }

  // Elemento da lista nativa numa área sem itens (onde o Drive abre o menu "Nova pasta / Upload").
  function nativeBlankTarget() {
    const main = findMain();
    if (!main) return null;
    const mr = main.getBoundingClientRect();
    const rows = nativeRows();
    const bottom = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : mr.top + 60;
    if (bottom > mr.bottom - 24) return null;
    const x = mr.left + mr.width / 2;
    const y = (bottom + mr.bottom) / 2;
    return document.elementsFromPoint(x, y).find((e) => main.contains(e) && !(ui.root && ui.root.contains(e))) || null;
  }
  // Botão do título da pasta no cabeçalho ("Projetos ▾"), que abre as ações da pasta atual.
  function folderTitleButton() {
    const main = findMain();
    if (!main) return null;
    const top = main.getBoundingClientRect().top;
    const title = pageTitle();
    return [...document.querySelectorAll('[role="button"][aria-haspopup="true"]')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.height > 0 && r.bottom <= top && b.textContent.trim() === title;
    }) || null;
  }

  async function nativeContextMenu(tr, x, y) {
    const pos = { clientX: x, clientY: y, button: 2 };
    let target = tr ? rowTarget(tr) : nativeBlankTarget();
    if (!target && !tr) {
      const btn = folderTitleButton();
      if (btn) {
        fire(btn, 'mousedown');
        fire(btn, 'mouseup');
        fire(btn, 'click');
      }
      return;
    }
    if (!target) return;
    fire(target, 'mousedown', pos);
    fire(target, 'mouseup', pos);
    fire(target, 'contextmenu', pos);
  }

  function shortcutInit(key, code, keyCode, extra = {}) {
    return { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...extra };
  }
  const DRIVE_MOD = IS_MAC ? { altKey: true, metaKey: true } : { altKey: true, ctrlKey: true };

  function dispatchKeyToNative(init) {
    const sel = nativeSelected();
    const target = sel[0] || nativeGrid() || findMain();
    if (!target) return;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  async function forwardKey(init, { needsSelection = true } = {}) {
    if (needsSelection) {
      if (!(await prepareNative())) return;
    } else {
      const c = S.cols[S.active];
      if (!c || !(await ensureNative(c.key))) return;
    }
    dispatchKeyToNative(init);
  }

  const openUrl = (it) => `https://drive.google.com/open?id=${encodeURIComponent(it.id)}&authuser=${authuser()}`;

  async function openSelected() {
    const c = S.cols[S.active];
    const items = selItems(c);
    if (items.length !== 1) return;
    if (items[0].isFolder) return goRight();
    // Abre direto pela URL, ainda dentro do gesto do usuário: o duplo clique sintético na lista
    // nativa não é confiável (o Drive ignora eventos não confiáveis e o pop-up perde a ativação).
    if (window.open(openUrl(items[0]), '_blank')) return;
    if (!(await prepareNative())) return;
    const tr = rowById(items[0].id);
    if (tr) {
      nativeClick(tr);
      fire(rowTarget(tr), 'dblclick', { detail: 2 });
    }
  }

  // ================================================================ colunas: modelo

  function makeCol(key, title, extra = {}) {
    return {
      key, title, items: S.cache.get(key) || null, byId: new Map((S.cache.get(key) || []).map((i) => [i.id, i])),
      sel: new Set(), cursor: null, anchor: null, complete: false, error: false,
      el: null, list: null, w: S.colW, ...extra,
    };
  }

  function setItems(c, items, complete) {
    const sigOld = c.items ? c.items.map((i) => i.id + i.name).join('|') : null;
    const sigNew = items.map((i) => i.id + i.name).join('|');
    c.items = items;
    c.byId = new Map(items.map((i) => [i.id, i]));
    c.error = false;
    if (complete) c.complete = true;
    const ci = S.cols.indexOf(c);
    if (c.complete) {
      let lost = false;
      for (const id of [...c.sel]) {
        if (!c.byId.has(id)) {
          c.sel.delete(id);
          lost = true;
        }
      }
      if (lost && ci >= 0) {
        truncateAfter(ci);
        if (S.active > ci) S.active = ci;
        if (c.sel.size === 1) openSelection(ci, false);
        renderAll();
      }
    }
    if (sigOld !== sigNew) fillCol(c);
    if (ci >= 0 && ci === S.active && S.preview && !S.preview.multi && c.byId.has(S.preview.id)) {
      S.preview = c.byId.get(S.preview.id);
      renderPreview();
    }
    if (c.selectFirstOnLoad && items.length && ci === S.active) {
      c.selectFirstOnLoad = false;
      selectIds(ci, [items[0].id]);
    }
  }

  function truncateAfter(ci) {
    for (const c of S.cols.splice(ci + 1)) c.el && c.el.remove();
    S.preview = null;
  }

  async function build() {
    S.needsBuild = false;
    const seq = ++S.buildSeq;
    const stale = () => seq !== S.buildSeq;
    for (const c of S.cols) c.el && c.el.remove();
    S.userTouched = false;
    const key = curKey();
    const col0 = makeCol(key, pageTitle());
    S.cols = [col0];
    S.active = 0;
    S.preview = null;
    S.nativeDirty = true;
    renderAll();
    await waitSettled(key, stale);
    if (stale()) return;
    // Só a primeira construção (carga da página por URL) segue a preferência Pasta/Caminho.
    // Depois, ao ligar as colunas ou navegar dentro do Drive, o caminho completo é sempre montado.
    const initial = S.initialBuild;
    S.initialBuild = false;
    if (!isFolderKey(key) || key === '/drive/my-drive') return;

    // Modo "só a pasta" (padrão, como o Finder): na carga por URL, mostra apenas a coluna da pasta atual.
    if (initial && S.pathMode !== 'full') return;
    // Caminho completo: as pastas ancestrais vêm do breadcrumb do cabeçalho.
    const quit = () => stale() || S.userTouched;
    let crumbs = await waitCrumbs(stale);
    if (!crumbs.length || quit()) return;
    const note = busyNote('Montando o caminho…');
    try {
      crumbs = await expandCrumbs(crumbs, stale);
      if (quit()) return;
      const ids = [...crumbs.map((c) => c.id), key.split('/').pop()];
      // Carrega antes as pastas que faltam e mostra o caminho inteiro de uma vez, em vez de coluna por coluna.
      await preloadChain(crumbs, ids, quit);
      if (quit()) return;
      let anc = crumbs.map((cr, i) => {
        const c = makeCol(cr.key, cr.name);
        c.sel.add(ids[i + 1]);
        c.cursor = c.anchor = ids[i + 1];
        if (!c.items) c.lazy = true;
        return c;
      });
      // Caminho não contínuo (a pasta não contém a seguinte): descarta as colunas até ela.
      const cut = anc.reduce((n, c, i) => (c.items && !c.byId.has(ids[i + 1]) ? i + 1 : n), 0);
      anc = anc.slice(cut);
      S.cols = [...anc, col0];
      S.active = S.cols.length - 1;
      renderAll();
      scrollToEnd(false);
      for (const c of anc) scrollRowIntoView(c, c.cursor);
    } finally {
      note.remove();
    }
    if (!quit()) await ensureNative(key, quit);
  }

  // Abre na lista nativa cada pasta do caminho cujo conteúdo ainda não está no cache (a subida do
  // expandCrumbs já deixa várias carregadas) e espera aparecer a pasta seguinte do caminho.
  async function preloadChain(crumbs, ids, quit) {
    for (let i = 0; i < crumbs.length && !quit(); i++) {
      const k = crumbs[i].key;
      const has = () => (S.cache.get(k) || []).some((it) => it.id === ids[i + 1]);
      if (has()) continue;
      if (!(await ensureNative(k, quit))) continue;
      await waitFor(() => quit() || has() || (S.nat.key === k && S.nat.complete), 8000);
    }
  }

  // ================================================================ seleção e navegação

  function selItems(c) {
    return c ? [...c.sel].map((id) => c.byId.get(id)).filter(Boolean) : [];
  }

  function selectIds(ci, ids, { keepAnchor = false } = {}) {
    const c = S.cols[ci];
    if (!c) return;
    c.sel = new Set(ids);
    if (ids.length) {
      c.cursor = ids[ids.length - 1];
      if (!keepAnchor) c.anchor = ids[0];
    }
    afterSelect(ci);
  }

  function openSelection(ci, load = true) {
    const c = S.cols[ci];
    const items = selItems(c);
    if (items.length === 1) {
      const it = items[0];
      if (it.isFolder) {
        const nc = it.isShortcut
          ? makeCol('shortcut:' + it.id, it.name, { pendingShortcut: true })
          : makeCol(keyForId(it.id), it.name);
        S.cols.push(nc);
      } else {
        S.preview = it;
      }
    } else if (items.length > 1) {
      S.preview = { multi: items };
    }
    return load;
  }

  function afterSelect(ci) {
    const c = S.cols[ci];
    S.userTouched = true;
    S.active = ci;
    truncateAfter(ci);
    openSelection(ci);
    renderAll();
    scrollToEnd(true);
    scrollRowIntoView(c, c.cursor);
    reconcile();
  }

  function onRowClick(e, ci, id) {
    const c = S.cols[ci];
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(c.sel);
      next.has(id) ? next.delete(id) : next.add(id);
      c.sel = next;
      c.cursor = c.anchor = id;
      afterSelect(ci);
    } else if (e.shiftKey && c.anchor && c.byId.has(c.anchor)) {
      const a = c.items.findIndex((i) => i.id === c.anchor);
      const b = c.items.findIndex((i) => i.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      c.sel = new Set(c.items.slice(lo, hi + 1).map((i) => i.id));
      c.cursor = id;
      afterSelect(ci);
    } else {
      if (c.sel.size === 1 && c.sel.has(id) && S.active === ci && S.cols.length > ci + 1 === selItems(c)[0]?.isFolder) {
        reconcile();
        return;
      }
      selectIds(ci, [id]);
    }
  }

  function onBlankClick(ci) {
    const c = S.cols[ci];
    if (!c) return;
    S.userTouched = true;
    c.sel.clear();
    S.active = ci;
    truncateAfter(ci);
    renderAll();
    reconcile();
  }

  function moveCursor(delta, extend) {
    const ci = S.active;
    const c = S.cols[ci];
    if (!c || !c.items || !c.items.length) return;
    let idx = c.items.findIndex((i) => i.id === c.cursor);
    idx = idx < 0 ? (delta > 0 ? 0 : c.items.length - 1) : Math.max(0, Math.min(c.items.length - 1, idx + delta));
    const id = c.items[idx].id;
    if (extend && c.anchor && c.byId.has(c.anchor)) {
      const a = c.items.findIndex((i) => i.id === c.anchor);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      c.sel = new Set(c.items.slice(lo, hi + 1).map((i) => i.id));
      c.cursor = id;
      afterSelect(ci);
    } else selectIds(ci, [id]);
  }

  function goRight() {
    const ci = S.active;
    const items = selItems(S.cols[ci]);
    if (items.length !== 1 || !items[0].isFolder) return;
    const next = S.cols[ci + 1];
    if (!next) return;
    if (next.items && next.items.length) selectIds(ci + 1, [next.items[0].id]);
    else if (!next.items) {
      next.selectFirstOnLoad = true;
      S.active = ci + 1;
      renderAll();
    }
  }

  function goParent() {
    const ci = S.active;
    if (ci === 0) return;
    S.cols[ci].sel.clear();
    S.active = ci - 1;
    truncateAfter(ci);
    renderAll();
    scrollRowIntoView(S.cols[ci - 1], S.cols[ci - 1].cursor);
    reconcile();
  }

  function typeSelect(ch) {
    const c = S.cols[S.active];
    if (!c || !c.items) return;
    clearTimeout(S.typeT);
    S.typeBuf += norm(ch);
    S.typeT = setTimeout(() => (S.typeBuf = ''), 900);
    const hit = c.items.find((i) => norm(i.name).startsWith(S.typeBuf));
    if (hit) selectIds(S.active, [hit.id]);
  }

  // ================================================================ arrastar e soltar
  //
  // Mover entre colunas: o Drive não tem recortar/colar, e o arraste nativo só move para o que
  // está visível na mesma lista (em outra pasta ele cria um atalho). Por isso a extensão usa a
  // janela "Mover" (⌥⌘M): seleciona os itens na lista nativa, abre a janela, cola o endereço da
  // pasta de destino na busca dela e clica em "Mover" na linha da pasta.
  //
  // Arquivos vindos do computador: a lista nativa vai para a pasta de destino e recebe o mesmo
  // "drop" que o usuário fez nas colunas.

  const DRAG_TYPE = 'application/x-gdf-items';
  const SPRING_MS = 800; // parar em cima de uma pasta durante o arraste abre a pasta
  const NO_DROP_KEYS = new Set([COMPUTERS_KEY, '/drive/trash']);

  function canDragFrom(c) {
    return !!(c && c.items && isSupported(c.key) && !NO_DROP_KEYS.has(c.key));
  }

  function dragKind(dt) {
    const types = dt ? [...dt.types] : [];
    if (types.includes(DRAG_TYPE)) return S.drag ? 'items' : null;
    return types.includes('Files') ? 'files' : null;
  }

  // Pasta em que um item seria solto: a pasta sob o cursor ou, fora dela, a pasta da própria coluna.
  function dropTargetFor(e, c) {
    if (S.busy || NO_DROP_KEYS.has(c.key) || S.cols.indexOf(c) < 0) return null;
    const row = e.target.closest && e.target.closest('.gdf-row');
    const it = row && c.byId.get(row.dataset.id);
    if (it && it.isFolder && !it.isShortcut) return { col: c, item: it, row, key: keyForId(it.id) };
    return isFolderKey(c.key) ? { col: c, item: null, row: null, key: c.key } : null;
  }

  function canDropItems(t) {
    const d = S.drag;
    if (!d || t.key === d.srcKey || (t.item && d.ids.includes(t.item.id))) return false;
    // Pasta arrastada que está aberta nas colunas: não pode ir para dentro dela mesma.
    const keys = new Set(d.ids.map(keyForId));
    const k = S.cols.findIndex((c) => keys.has(c.key));
    return k < 0 || S.cols.indexOf(t.col) < k;
  }

  function setDropTarget(t) {
    const p = S.dropT;
    if (p && t && p.col === t.col && p.row === t.row) return;
    if (p) (p.row || p.col.el).classList.remove('gdf-drop');
    S.dropT = t;
    if (t) (t.row || t.col.el).classList.add('gdf-drop');
    // Mola: parar em cima de uma pasta fechada abre a coluna dela.
    clearTimeout(S.spring.t);
    S.spring = { id: null, t: 0 };
    if (t && t.item) {
      S.spring = { id: t.item.id, t: setTimeout(guarded('arrastar', () => springOpen(t)), SPRING_MS) };
    }
  }
  const clearDropTarget = () => setDropTarget(null);

  function springOpen(t) {
    if (S.dropT !== t) return;
    const ci = S.cols.indexOf(t.col);
    if (ci < 0) return;
    const next = S.cols[ci + 1];
    if (t.col.sel.size === 1 && t.col.sel.has(t.item.id) && next && next.key === t.key) return;
    t.col.cursor = t.item.id;
    selectIds(ci, [t.item.id]);
  }

  function onDragStart(e, c) {
    const row = e.target.closest && e.target.closest('.gdf-row');
    if (!row || S.busy || !canDragFrom(c)) {
      e.preventDefault();
      return;
    }
    const id = row.dataset.id;
    // Como no Finder: arrastar um item selecionado leva a seleção inteira; um não selecionado vai sozinho.
    const ids = c.sel.has(id) ? c.items.filter((i) => c.sel.has(i.id)).map((i) => i.id) : [id];
    const items = ids.map((i) => c.byId.get(i)).filter(Boolean);
    S.drag = { srcKey: c.key, ids, items };
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copyMove';
    dt.setData(DRAG_TYPE, JSON.stringify(ids));
    // Soltar em outro app (e-mail, chat, outra aba) entrega o link dos arquivos.
    dt.setData('text/uri-list', items.map(openUrl).join('\r\n'));
    dt.setData('text/plain', items.map(openUrl).join('\n'));
    if (items.length > 1) {
      const badge = h('div', { class: 'gdf-drag-badge' }, itemIcon(items[0], 18), plural(items.length, '1 item', '# itens'));
      ui.layer.append(badge);
      dt.setDragImage(badge, 14, 14);
      setTimeout(() => badge.remove(), 0);
    }
    for (const r of c.list.querySelectorAll('.gdf-row')) if (ids.includes(r.dataset.id)) r.classList.add('gdf-dragging');
  }

  function onDragEnd() {
    S.drag = null;
    clearDropTarget();
    if (ui.root) for (const r of ui.root.querySelectorAll('.gdf-dragging')) r.classList.remove('gdf-dragging');
  }

  function onDragOver(e, c) {
    const kind = dragKind(e.dataTransfer);
    const t = kind && dropTargetFor(e, c);
    if (!t || (kind === 'items' && !canDropItems(t))) return clearDropTarget();
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === 'items' ? 'move' : 'copy';
    setDropTarget(t);
    if (kind === 'files') {
      prefetchNative(t.key);
      nativeDragHover(e.dataTransfer, t.key);
    }
  }

  function onDrop(e, c) {
    const kind = dragKind(e.dataTransfer);
    const t = kind && dropTargetFor(e, c);
    const drag = S.drag;
    clearDropTarget();
    if (!t) return;
    if (kind === 'items') {
      if (!canDropItems(t)) return;
      e.preventDefault();
      moveItems(drag, t);
    } else {
      e.preventDefault();
      uploadFiles(e.dataTransfer, t);
    }
  }

  // ---------------------------------------------------------------- mover (janela "Mover" do Drive)

  const PICKER_SEL = 'iframe[src*="/picker/"]';
  function pickerFrame() {
    for (const f of document.querySelectorAll(PICKER_SEL)) {
      const r = f.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      try {
        if (f.contentDocument && f.contentDocument.body) return f;
      } catch {
        /* outra origem */
      }
    }
    return null;
  }
  const pickerOpen = (f) => f.isConnected && f.getBoundingClientRect().width > 0;

  function frameClick(f, el) {
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true, view: f.contentWindow,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
    };
    const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', p));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }
  function frameKey(el, key, code, keyCode) {
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, init));
  }
  function closePicker(f) {
    if (f && pickerOpen(f)) frameKey(f.contentDocument.activeElement || f.contentDocument.body, 'Escape', 'Escape', 27);
  }

  // Na janela "Mover" já aberta: acha a pasta pelo id (ou pela busca com o endereço dela) e clica em "Mover".
  async function pickerMoveTo(f, destId) {
    // O documento da janela pode ser trocado enquanto ela carrega: sempre lê o atual.
    const all = (sel) => {
      const d = f.contentDocument;
      return d ? [...d.querySelectorAll(sel)] : [];
    };
    const visible = (el) => el.getBoundingClientRect().height > 0;
    const destRow = () => all(`tr[data-target-folder-id="${CSS.escape(destId)}"]`).find(visible);
    const searchBtn = () => all('button[aria-label="Pesquisar"], button[aria-label="Search"]').find(visible);
    // Na primeira vez a janela leva alguns segundos para carregar; depois ela é reaproveitada
    // e, logo ao abrir, ainda tem o conteúdo antigo (invisível).
    await waitFor(() => all('tr[data-target-folder-id]').some(visible) || searchBtn(), 15000);
    let row = destRow();
    if (!row) {
      const urlInput = () => all('input').find((i) => visible(i) && /url/i.test(`${i.getAttribute('aria-label')} ${i.placeholder}`));
      let input = urlInput();
      for (let k = 0; !input && k < 4; k++) {
        const search = searchBtn();
        if (search) frameClick(f, search);
        input = await waitFor(urlInput, 800);
      }
      if (!input) throw new Error('a busca da janela Mover não foi encontrada');
      const url = 'https://drive.google.com/drive/folders/' + destId;
      input.focus();
      input.select();
      if (!input.ownerDocument.execCommand('insertText', false, url) || input.value !== url) {
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      frameKey(input, 'Enter', 'Enter', 13);
      row = await waitFor(destRow, 8000);
      if (!row) throw new Error('a pasta de destino não apareceu na janela Mover');
    }
    // Na primeira abertura a janela aparece antes de o Drive ligar os botões, e o clique se perde:
    // repete enquanto ela continuar aberta.
    for (let k = 0; k < 5; k++) {
      const r = destRow() || row;
      const btn = r.querySelector('button[aria-label^="Mover para"], button[aria-label^="Move to"]') || r.querySelector('button');
      if (!btn) throw new Error('o botão Mover da janela não foi encontrado');
      frameClick(f, btn);
      if (await waitFor(() => !pickerOpen(f), 1500 + k * 500)) return;
    }
    throw new Error('a janela Mover não confirmou');
  }

  // Indicador discreto no rodapé das colunas, que não bloqueia nada.
  function busyNote(text) {
    const el = h('div', { class: 'gdf-busy', role: 'status' }, h('div', { class: 'gdf-spin gdf-spin-sm' }), h('span', null, text));
    ui.root.append(el);
    return el;
  }
  function paintMoving(ids, on) {
    for (const id of ids) on ? S.moving.add(id) : S.moving.delete(id);
    for (const r of ui.root.querySelectorAll('.gdf-row')) r.classList.toggle('gdf-moving', S.moving.has(r.dataset.id));
  }

  async function moveItems(drag, t) {
    if (S.busy) return;
    S.busy = true;
    ++S.recSeq; // cancela sincronizações pendentes da seleção
    const what = drag.items.length === 1 ? `“${drag.items[0].name}”` : plural(drag.items.length, '1 item', '# itens');
    const dest = t.item ? t.item.name : t.col.title;
    const note = busyNote(`Movendo ${what} para “${dest}”…`);
    paintMoving(drag.ids, true);
    // A janela "Mover" do Drive trabalha escondida (e sem bloquear cliques); se algo der errado
    // ela volta a aparecer, já que o "finally" sempre tira a classe.
    const html = document.documentElement;
    html.classList.add('gdf-moving');
    let f = null;
    try {
      if (!(await ensureNative(drag.srcKey))) throw new Error('o Drive não abriu a pasta de origem');
      // Soltar na coluna "Meu Drive": o id dela vem do breadcrumb da pasta de origem.
      if (!S.rootId && t.key === '/drive/my-drive') S.rootId = (scrapeCrumbs()[0] || {}).id || null;
      const destId = t.item ? t.item.id : folderIdOf(t.key);
      if (!destId) throw new Error('a pasta de destino não foi identificada');
      await applyNativeSelection(drag.ids);
      const sel = nativeSelected().map((r) => r.getAttribute('data-id'));
      if (sel.length !== drag.ids.length || !drag.ids.every((id) => sel.includes(id))) {
        throw new Error('os itens não foram encontrados na lista do Drive');
      }
      dispatchKeyToNative(shortcutInit('m', 'KeyM', 77, DRIVE_MOD));
      f = await waitFor(pickerFrame, 8000);
      if (!f) throw new Error('a janela Mover do Drive não abriu');
      await pickerMoveTo(f, destId);
      // Espera os itens saírem da lista nativa (é o que confirma que o Drive moveu; a janela também
      // fecha com Esc) e só então os tira da coluna de origem: enquanto a lista nativa não termina
      // de carregar, a sincronização mantém os itens que já conhecia.
      if (!(await waitFor(() => !nativeRows().some((r) => drag.ids.includes(r.getAttribute('data-id'))), 4000))) {
        throw new Error('o Drive não confirmou a mudança');
      }
      const gone = (i) => !drag.ids.includes(i.id);
      for (const c of S.cols) if (c.key === drag.srcKey && c.items) setItems(c, c.items.filter(gone), c.complete);
      if (S.cache.has(drag.srcKey)) S.cache.set(drag.srcKey, S.cache.get(drag.srcKey).filter(gone));
      syncNative();
      S.cache.delete(t.key);
      if (S.cols.some((c) => c.key === t.key)) await ensureNative(t.key);
    } catch (err) {
      console.warn('[GDrive macOS style] mover:', err);
      // A janela fica aberta se o problema foi na confirmação (pode haver uma pergunta do Drive nela).
      if (f && !/confirmou/.test(err.message)) closePicker(f);
      toast(`Não foi possível mover: ${err.message}. Use “Mover” (⌥⌘M) no menu do Drive.`, 10000);
    } finally {
      html.classList.remove('gdf-moving');
      note.remove(); // no sucesso, o Drive mostra o próprio aviso, com "Desfazer"
      paintMoving(drag.ids, false);
      S.busy = false;
      reconcile();
      if (S.wantFocus) focusRoot();
    }
  }

  // ---------------------------------------------------------------- enviar arquivos do computador

  // Enquanto arquivos passam sobre as colunas, a lista nativa já vai para a pasta de destino:
  // assim, ao soltar, o próprio evento é repassado (e pastas inteiras também são enviadas).
  function prefetchNative(key) {
    if (S.prefetch.key === key) return;
    clearTimeout(S.prefetch.t);
    S.prefetch = {
      key,
      t: setTimeout(guarded('arrastar', () => {
        if (S.prefetch.key !== key || curKey() === key) return;
        ++S.recSeq;
        ensureNative(key);
      }), 250),
    };
  }

  function nativeDropTarget() {
    const main = findMain();
    return nativeGrid(main) || nativeBlankTarget() || (main && main.firstElementChild);
  }
  function fireDrag(el, type, dt) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: r.left + 10, clientY: r.top + 10, dataTransfer: dt,
    }));
  }
  const nativeReadyAt = (key) => curKey() === key && S.nat.key === key && S.nat.settled && !S.nat.failed;

  // A lista nativa precisa receber o arraste como num arraste de verdade: dragenter/dragover enquanto
  // os arquivos passam e o drop só no fim. Com dragover e drop no mesmo instante, o Drive faz o
  // upload, mas esconde o painel de progresso do canto inferior direito.
  function nativeDragHover(dt, key) {
    const nd = S.natDrop;
    if (nd && nd.key === key && nd.el.isConnected) return;
    nativeDragLeave();
    if (!nativeReadyAt(key)) return;
    const el = nativeDropTarget();
    if (!el) return;
    fireDrag(el, 'dragenter', dt);
    fireDrag(el, 'dragover', dt);
    S.natDrop = { key, el, dt };
  }
  function nativeDragLeave() {
    const nd = S.natDrop;
    S.natDrop = null;
    if (nd && nd.el.isConnected) fireDrag(nd.el, 'dragleave', nd.dt);
  }

  function uploadFiles(dt, t) {
    S.prefetch = { key: null, t: 0 };
    const nd = S.natDrop;
    S.natDrop = null;
    // A lista nativa já recebeu o dragenter/dragover enquanto os arquivos passavam: repassa só o
    // próprio "drop" (que preserva pastas arrastadas, cujo conteúdo só existe durante o evento).
    if (nd && nd.key === t.key && nd.el.isConnected && nativeReadyAt(t.key)) {
      fireDrag(nd.el, 'drop', dt);
      return;
    }
    if (nd && nd.el.isConnected) fireDrag(nd.el, 'dragleave', nd.dt);
    // Senão, guarda os arquivos e envia quando a pasta estiver aberta por baixo.
    const files = [];
    let folders = 0;
    for (const item of dt.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry && entry.isDirectory) folders++;
      else {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (folders) {
      // Pasta já aberta por baixo, só sem o dragenter: envia tudo agora, num evento só
      // (o upload funciona, mas o Drive não mostra o painel de progresso).
      if (nativeReadyAt(t.key)) {
        const el = nativeDropTarget();
        if (el) for (const type of ['dragenter', 'dragover', 'drop']) fireDrag(el, type, dt);
        return;
      }
      toast(`${plural(folders, '1 pasta não foi enviada', '# pastas não foram enviadas')}: solte de novo depois que a coluna terminar de carregar.`, 10000);
    }
    if (!files.length) return;
    const my = ++S.recSeq;
    (async () => {
      if (!(await ensureNative(t.key, () => my !== S.recSeq)) || !nativeReadyAt(t.key)) {
        toast('Não foi possível enviar: o Drive não abriu a pasta de destino.');
        return;
      }
      const copy = new DataTransfer();
      for (const file of files) copy.items.add(file);
      const el = nativeDropTarget();
      if (!el) return toast('Não foi possível enviar: a lista do Drive não foi encontrada.');
      // Intervalo entre dragover e drop, como num arraste de verdade (senão o painel de upload some).
      fireDrag(el, 'dragenter', copy);
      fireDrag(el, 'dragover', copy);
      await sleep(150);
      fireDrag(el, 'drop', copy);
    })().catch((e) => reportError(e, 'enviar'));
  }

  // ================================================================ UI

  function buildUi() {
    ui.root = h('div', { class: 'gdf-scope gdf-root', tabindex: '0', 'aria-label': 'Visualização em colunas' });
    ui.strip = h('div', { class: 'gdf-strip' });
    ui.root.append(ui.strip);
    ui.layer = h('div', { class: 'gdf-scope gdf-layer' });
    ui.root.addEventListener('mousedown', (e) => {
      S.wantFocus = true;
      if (!isEditable(e.target) && !e.target.closest('.gdf-resize')) setTimeout(focusRoot, 0);
    });
    // Arrastes sobre as colunas não chegam ao Drive. Onde nenhuma coluna aceitou (ex.: pré-visualização),
    // o "drop" é recusado, para o navegador não abrir o arquivo solto no lugar do Drive.
    for (const t of ['dragenter', 'dragover', 'drop']) {
      ui.root.addEventListener(t, (e) => {
        e.stopPropagation();
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (t === 'drop') {
          clearDropTarget();
          nativeDragLeave();
        } else {
          e.dataTransfer.dropEffect = 'none';
          if (t === 'dragover') clearDropTarget();
        }
      });
    }
    ui.root.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      if (!ui.root.contains(e.relatedTarget)) {
        clearDropTarget();
        nativeDragLeave();
      }
    });
    // O Drive cancela todo dragstart que chega ao documento (o arraste dele é próprio).
    for (const t of ['dragstart', 'drag', 'dragend']) ui.root.addEventListener(t, (e) => e.stopPropagation());
  }
  function focusRoot() {
    if (ui.root && ui.root.isConnected) ui.root.focus({ preventScroll: true });
  }

  function ensureColEl(c) {
    if (c.el) return c.el;
    const list = h('div', { class: 'gdf-list', role: 'listbox', 'aria-multiselectable': 'true' });
    const grip = h('div', { class: 'gdf-resize', title: 'Arraste para redimensionar (⌥ redimensiona todas)' });
    c.el = h('div', { class: 'gdf-col', style: { width: c.w + 'px' } }, list, grip);
    c.list = list;
    bindColumnEvents(c, list, grip);
    fillCol(c);
    return c.el;
  }

  function fillCol(c) {
    if (!c.list) return;
    const list = c.list;
    const top = list.scrollTop;
    if (c.lazy && !c.items) {
      list.replaceChildren(h('div', { class: 'gdf-empty gdf-muted' }, 'Clique aqui para carregar'));
    } else if (c.error && !c.items) {
      list.replaceChildren(h('div', { class: 'gdf-empty gdf-muted' }, 'Não foi possível abrir esta pasta.'));
    } else if (!c.items) {
      list.replaceChildren(h('div', { class: 'gdf-empty' }, h('div', { class: 'gdf-spin' })));
    } else if (!c.items.length) {
      list.replaceChildren(h('div', { class: 'gdf-empty gdf-muted' }, 'Pasta vazia'));
    } else {
      const frag = document.createDocumentFragment();
      for (const it of c.items) frag.append(rowEl(it));
      if (!c.complete && c.items.length >= 50) frag.append(h('div', { class: 'gdf-more gdf-muted' }, h('div', { class: 'gdf-spin gdf-spin-sm' })));
      list.replaceChildren(frag);
      list.scrollTop = top;
    }
    paintSel(c);
  }

  function itemIcon(it, size) {
    const node = it.icon ? it.icon.cloneNode(true) : icon(it.isFolder ? 'folder' : 'file', size);
    node.setAttribute('width', size);
    node.setAttribute('height', size);
    node.style.width = node.style.height = size + 'px';
    return h('span', { class: 'gdf-fico' }, node);
  }

  function rowEl(it) {
    return h('div', {
      class: 'gdf-row' + (it.isFolder ? ' is-folder' : '') + (S.moving.has(it.id) ? ' gdf-moving' : ''),
      'data-id': it.id,
      role: 'option',
      title: it.name,
      draggable: 'true',
    },
    itemIcon(it, 20),
    h('span', { class: 'gdf-name' }, it.name),
    it.isFolder ? h('span', { class: 'gdf-chev' }, icon('chevron', 18)) : null);
  }

  function paintSel(c) {
    if (!c.el) return;
    c.el.classList.toggle('active', S.cols.indexOf(c) === S.active);
    for (const row of c.list.children) {
      const id = row.dataset && row.dataset.id;
      if (!id) continue;
      const on = c.sel.has(id);
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function renderAll() {
    if (!ui.root) return;
    const want = S.cols.map(ensureColEl);
    for (const ch of [...ui.strip.children]) if (!want.includes(ch) && ch !== ui.preview) ch.remove();
    want.forEach((el, i) => {
      if (ui.strip.children[i] !== el) ui.strip.insertBefore(el, ui.strip.children[i] || null);
    });
    renderPreview();
    S.cols.forEach(paintSel);
  }

  // ---------------------------------------------------------------- pré-visualização

  function thumbUrl(it) {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(it.id)}&sz=w800&authuser=${authuser()}`;
  }

  function renderPreview() {
    const p = S.preview;
    if (!p) {
      if (ui.preview) ui.preview.remove();
      ui.previewKey = '';
      return;
    }
    if (!ui.preview) ui.preview = h('div', { class: 'gdf-preview' });
    const key = p.multi ? 'm:' + p.multi.map((i) => i.id).join(',') : `${p.id}|${p.name}|${JSON.stringify(p.info)}`;
    if (key !== ui.previewKey) {
      ui.previewKey = key;
      ui.preview.replaceChildren(...(p.multi ? previewMulti(p.multi) : previewSingle(p)));
    }
    if (ui.strip.lastChild !== ui.preview) ui.strip.append(ui.preview);
  }

  function previewSingle(it) {
    const thumb = h('div', { class: 'gdf-pv-thumb' });
    const fallback = () => thumb.replaceChildren(h('div', { class: 'gdf-pv-icon' }, itemIcon(it, 96)));
    if (!it.isShortcut) {
      const img = h('img', { alt: '', draggable: 'false', src: thumbUrl(it) });
      img.addEventListener('error', fallback, { once: true });
      img.addEventListener('load', () => (img.naturalWidth > 1 ? img.classList.add('ok') : fallback()));
      img.addEventListener('dblclick', () => openSelected());
      thumb.append(img);
    } else fallback();

    const size = (it.info.find(([k]) => /tamanho|size/i.test(k)) || [])[1];
    const rows = [['Tipo', it.type || '—'], ...it.info, ['Acesso', it.shared ? 'Compartilhado' : 'Particular']];
    return [
      thumb,
      h('div', { class: 'gdf-pv-name' }, it.name),
      h('div', { class: 'gdf-pv-kind' }, [it.type, size && size !== '—' ? size : null].filter(Boolean).join(' – ')),
      h('div', { class: 'gdf-pv-actions' },
        h('button', { class: 'gdf-btn', onclick: () => openSelected() }, icon('open', 18), 'Abrir'),
        h('button', { class: 'gdf-btn gdf-btn-tonal', onclick: () => forwardKey(shortcutInit('p', 'KeyP', 80, DRIVE_MOD)) }, icon('eye', 18), 'Visualizar')),
      h('div', { class: 'gdf-pv-sec' }, 'Informações'),
      h('dl', { class: 'gdf-pv-info' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('button', {
        class: 'gdf-pv-more',
        onclick: async (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (!(await prepareNative())) return;
          nativeContextMenu(rowById(it.id), r.left, r.bottom + 4);
        },
      }, icon('more', 18), 'Mais ações'),
    ];
  }

  function previewMulti(items) {
    const stack = h('div', { class: 'gdf-pv-stack' }, items.slice(0, 3).map((it) => h('div', { class: 'gdf-pv-stack-i' }, itemIcon(it, 88))));
    return [
      h('div', { class: 'gdf-pv-thumb' }, stack),
      h('div', { class: 'gdf-pv-name' }, `${items.length} itens`),
      h('div', { class: 'gdf-pv-kind' }, 'Use a barra acima ou o botão direito para agir sobre todos'),
    ];
  }

  // ---------------------------------------------------------------- eventos das colunas

  function bindColumnEvents(c, list, grip) {
    const ciOf = () => S.cols.indexOf(c);
    const rowOf = (e) => e.target.closest && e.target.closest('.gdf-row');

    list.addEventListener('click', (e) => {
      const ci = ciOf();
      if (ci < 0) return;
      const row = rowOf(e);
      if (c.lazy && !c.items) {
        // Coluna ancestral ainda não lida: carrega sem mexer nas colunas à direita.
        c.lazy = false;
        fillCol(c);
        ++S.recSeq;
        ensureNative(c.key);
        return;
      }
      row ? onRowClick(e, ci, row.dataset.id) : onBlankClick(ci);
    });
    list.addEventListener('dblclick', (e) => {
      const row = rowOf(e);
      const it = row && c.byId.get(row.dataset.id);
      if (it && !it.isFolder) openSelected();
    });
    list.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const ci = ciOf();
      const row = rowOf(e);
      const { clientX: x, clientY: y } = e;
      if (row) {
        const id = row.dataset.id;
        const next = S.cols[ci + 1];
        // Pasta já aberta e carregada na coluna seguinte: mantém as colunas como estão.
        const keep = c.sel.size === 1 && c.sel.has(id) && next && next.items && !next.pendingShortcut;
        if (!c.sel.has(id)) {
          c.sel = new Set([id]);
          c.cursor = c.anchor = id;
        }
        S.active = ci;
        S.userTouched = true;
        if (!keep) {
          truncateAfter(ci);
          // Como no Finder, o clique direito numa pasta não abre a coluna dela.
          const it = c.byId.get(id);
          if (!(c.sel.size === 1 && it && it.isFolder)) openSelection(ci);
        }
        renderAll();
        if (!(await prepareNative())) return;
        nativeContextMenu(rowById(row.dataset.id), x, y);
      } else {
        onBlankClick(ci);
        if (!(await prepareNative())) return;
        nativeContextMenu(null, x, y);
      }
    });

    list.addEventListener('dragstart', guarded('arrastar', (e) => onDragStart(e, c)));
    list.addEventListener('dragend', guarded('arrastar', onDragEnd));
    list.addEventListener('dragenter', guarded('arrastar', (e) => onDragOver(e, c)));
    list.addEventListener('dragover', guarded('arrastar', (e) => onDragOver(e, c)));
    list.addEventListener('drop', guarded('soltar', (e) => onDrop(e, c)));

    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const w0 = c.w;
      const all = e.altKey;
      const onMove = (ev) => {
        const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, w0 + ev.clientX - x0));
        for (const k of all ? S.cols : [c]) {
          k.w = w;
          if (k.el) k.el.style.width = w + 'px';
        }
        if (all) S.colW = w;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        document.documentElement.classList.remove('gdf-resizing');
        if (all) storageSet({ gdfColW: S.colW });
      };
      document.documentElement.classList.add('gdf-resizing');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
  }

  function scrollToEnd(smooth) {
    requestAnimationFrame(() => ui.strip && ui.strip.scrollTo({ left: ui.strip.scrollWidth, behavior: smooth ? 'smooth' : 'auto' }));
  }
  function scrollRowIntoView(c, id) {
    if (!c || !c.list || !id) return;
    const row = c.list.querySelector(`.gdf-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ================================================================ teclado

  // Registrado em document_start, antes dos atalhos do Drive: teclas digitadas nas colunas
  // não chegam ao Drive diretamente — as que fazem sentido são repassadas à lista nativa.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (e) => {
      if (!ui.root || !ui.root.contains(e.target)) return;
      e.stopImmediatePropagation();
      if (type === 'keydown') guardedKey(e);
    }, true);
  }

  const guardedKey = (e) => guarded('teclado', onKey)(e);
  function onKey(e) {
    const ci = S.active;
    const c = S.cols[ci];
    if (!c) return;
    const mod = e.metaKey || e.ctrlKey;
    const items = selItems(c);
    const k = e.key;

    // Atalhos do próprio Drive (⌥⌘A compartilhar, ⌥⌘M mover, ⌥⌘S estrela, ⌥⌘E renomear…)
    if (e.altKey && mod && k.length === 1) {
      e.preventDefault();
      return forwardKey(shortcutInit(e.key, e.code, e.keyCode, { altKey: true, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }));
    }
    switch (k) {
      case 'ArrowDown':
        e.preventDefault();
        if (mod) openSelected();
        else moveCursor(1, e.shiftKey);
        return;
      case 'ArrowUp':
        e.preventDefault();
        mod ? goParent() : moveCursor(-1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        goRight();
        return;
      case 'ArrowLeft':
        e.preventDefault();
        goParent();
        return;
      case ' ':
        e.preventDefault();
        if (items.length === 1 && !items[0].isFolder) forwardKey(shortcutInit('p', 'KeyP', 80, DRIVE_MOD));
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (items.length === 1) forwardKey(shortcutInit('e', 'KeyE', 69, DRIVE_MOD));
        return;
      case 'Delete':
      case 'Backspace':
        if (k === 'Delete' || mod) {
          e.preventDefault();
          if (items.length) forwardKey(shortcutInit('Delete', 'Delete', 46));
        }
        return;
      case 'Escape':
        return;
    }
    if (mod) {
      const l = k.toLowerCase();
      if (l === 'a' && c.items) {
        e.preventDefault();
        c.sel = new Set(c.items.map((i) => i.id));
        afterSelect(ci);
      } else if (l === 'o') {
        e.preventDefault();
        openSelected();
      } else if ((l === 'c' || l === 'x') && items.length) {
        e.preventDefault();
        forwardKey(shortcutInit(e.key, e.code, e.keyCode, { metaKey: e.metaKey, ctrlKey: e.ctrlKey }));
      } else if (l === 'v') {
        e.preventDefault();
        forwardKey(shortcutInit(e.key, e.code, e.keyCode, { metaKey: e.metaKey, ctrlKey: e.ctrlKey }), { needsSelection: false });
      }
      return;
    }
    if (!e.altKey && k.length === 1 && /\S/.test(k)) {
      e.preventDefault();
      typeSelect(k);
    }
  }

  // ================================================================ integração com o Drive

  function isShowing() {
    return !!(S.enabled && isSupported(S.key) && ui.root && ui.root.isConnected);
  }

  function readTheme(main) {
    let el = main;
    let bg = null;
    while (el && el !== document.documentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c;
        break;
      }
      el = el.parentElement;
    }
    bg = bg || 'rgb(255, 255, 255)';
    if (bg === S.bg) return;
    const [r, g, b] = (bg.match(/\d+(\.\d+)?/g) || [255, 255, 255]).map(Number);
    S.dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
    S.bg = bg;
    for (const e of [ui.root, ui.layer]) {
      e.classList.toggle('gdf-dark', S.dark);
      e.style.setProperty('--gdf-bg', bg);
    }
  }

  function layout() {
    if (!ui.root || !ui.root.isConnected) return;
    const main = findMain();
    if (!main) {
      ui.root.style.display = 'none';
      return;
    }
    const r = main.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    Object.assign(ui.root.style, {
      display: '',
      left: r.left + 'px',
      top: top + 'px',
      width: r.width + 'px',
      height: Math.max(0, Math.min(r.bottom, innerHeight) - top) + 'px',
    });
    readTheme(main);
  }

  function learnToggleClasses(natives) {
    if (S.toggleCls) return;
    const on = natives.find((n) => n.getAttribute('aria-checked') === 'true');
    const off = natives.find((n) => n.getAttribute('aria-checked') !== 'true');
    if (!on || !off) return;
    const a = new Set(on.classList);
    const b = new Set(off.classList);
    S.toggleCls = { on: [...a].filter((x) => !b.has(x)), off: [...b].filter((x) => !a.has(x)) };
  }
  function setRadio(btn, checked) {
    const want = checked ? 'true' : 'false';
    if (btn.getAttribute('aria-checked') !== want) btn.setAttribute('aria-checked', want);
    if (S.toggleCls) {
      for (const c of S.toggleCls.on) if (btn.classList.contains(c) !== checked) btn.classList.toggle(c, checked);
      for (const c of S.toggleCls.off) if (btn.classList.contains(c) === checked) btn.classList.toggle(c, !checked);
    }
  }

  function injectToggle() {
    const list = document.querySelector('button[data-test-id="list-layout-button"]');
    if (!list) return;
    const group = list.parentElement;
    const natives = [...group.querySelectorAll(':scope > button[role="radio"]:not(.gdf-toggle)')];
    if (!natives.length) return;
    if (!group.querySelector(':scope > .gdf-toggle')) {
      learnToggleClasses(natives);
      const last = natives[natives.length - 1];
      const mine = last.cloneNode(true);
      for (const el of [mine, ...mine.querySelectorAll('*')]) {
        for (const a of ['jsaction', 'jscontroller', 'jsname', 'jscallback', 'jsmodel', 'jslog', 'data-test-id', 'aria-describedby', 'id', 'data-tooltip-enabled']) {
          el.removeAttribute(a);
        }
      }
      mine.classList.add('gdf-toggle');
      mine.setAttribute('aria-label', 'Colunas');
      mine.setAttribute('data-tooltip', 'Layout de colunas');
      mine.setAttribute('title', 'Layout de colunas');
      const slot = mine.querySelector('.znfGuf') || [...mine.querySelectorAll('svg')].pop()?.parentElement;
      if (slot) slot.replaceChildren(columnsIcon());
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'focus', 'mouseover', 'mouseout']) {
        mine.addEventListener(t, (e) => e.stopPropagation());
      }
      mine.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggleClick();
      });
      last.style.borderRadius = '0';
      last.after(mine);
      for (const n of natives) {
        if (n.__gdfBound) continue;
        n.__gdfBound = true;
        n.addEventListener('click', () => !S.ignoreNativeClick && S.enabled && setEnabled(false), true);
      }
      if (!group.__gdfObs) {
        group.__gdfObs = new MutationObserver(() => paintToggle());
        group.__gdfObs.observe(group, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-checked'] });
      }
    }
    paintToggle();
  }

  function paintToggle() {
    const mine = document.querySelector('.gdf-toggle');
    if (!mine) return;
    const natives = [...mine.parentElement.querySelectorAll(':scope > button[role="radio"]:not(.gdf-toggle)')];
    if (isShowing()) {
      for (const n of natives) {
        if (n.dataset.gdfSaved === undefined) n.dataset.gdfSaved = n.getAttribute('aria-checked') || 'false';
        setRadio(n, false);
      }
      setRadio(mine, true);
    } else {
      setRadio(mine, false);
      for (const n of natives) {
        if (n.dataset.gdfSaved === undefined) continue;
        const was = n.dataset.gdfSaved === 'true';
        delete n.dataset.gdfSaved;
        setRadio(n, was);
      }
    }
    mine.classList.toggle('gdf-unavailable', !isSupported(S.key));
  }

  function onToggleClick() {
    if (!isSupported(S.key)) {
      toast('A visualização em colunas não está disponível nesta seção do Drive.');
      return;
    }
    // Depois de um desligamento automático, clicar de novo tenta outra vez (a checagem continua valendo).
    if (S.broken) resetGuard();
    if (!S.enabled) setEnabled(true);
  }

  function storageSet(v) {
    try {
      EXT && EXT.storage.sync.set(v);
    } catch {
      /* contexto da extensão invalidado */
    }
  }

  function setEnabled(v) {
    S.enabled = v;
    storageSet({ gdfEnabled: v });
    if (v) {
      S.wantFocus = true;
      S.needsBuild = true;
      S.initialBuild = false; // ligar pelo botão não é carga por URL: monta o caminho completo
    } else {
      ++S.recSeq;
      ++S.buildSeq;
      // A paginação automática rolou a lista nativa; devolve ao topo.
      const sc = nativeScroller(nativeGrid());
      if (sc) sc.scrollTop = 0;
    }
    update();
    if (v) setTimeout(focusRoot, 50);
  }

  function update() {
    const show = !!(S.enabled && isSupported(S.key) && findMain());
    if (show) {
      if (!ui.root.isConnected) document.body.append(ui.root);
      layout();
      if (S.needsBuild) build().catch((e) => reportError(e, 'build'));
    } else if (ui.root && ui.root.isConnected) {
      ui.root.remove();
    }
    paintToggle();
  }

  function onUrlChange() {
    const key = curKey();
    S.key = key;
    const expected = S.expectKey;
    if (expected && (expected === key || expected === '*')) {
      S.expectKey = null;
      return update();
    }
    S.expectKey = null;
    if (!isSupported(key)) return update();
    // Voltar/avançar ou clique no breadcrumb para uma pasta que já está nas colunas.
    const ci = S.cols.findIndex((c) => c.key === key);
    if (ci >= 0 && !S.needsBuild) {
      S.cols[ci].sel.clear();
      S.active = ci;
      truncateAfter(ci);
      if (isShowing()) renderAll();
      return update();
    }
    S.needsBuild = true;
    update();
  }

  function tick() {
    if (location.href !== S.lastHref) {
      S.lastHref = location.href;
      onUrlChange();
    }
    if (S.enabled && isSupported(S.key) && ui.root && !ui.root.isConnected && findMain()) update();
    layout();
    if (isShowing()) syncNative();
    guardCheck();
  }

  // ---------------------------------------------------------------- toast

  let toastEl = null;
  function toast(msg, ms = 5000) {
    if (toastEl) toastEl.remove();
    const el = h('div', { class: 'gdf-toast', role: 'status' },
      h('span', null, msg),
      h('button', { class: 'gdf-toast-x', 'aria-label': 'Fechar', onclick: () => el.remove() }, '×'));
    ui.layer.append(el);
    toastEl = el;
    setTimeout(() => el.remove(), ms);
    return el;
  }

  // ================================================================ proteção contra mudanças do Drive
  //
  // A extensão depende do HTML interno do Drive. Se algo essencial sumir (ou o código começar a dar
  // erro), as colunas se desligam sozinhas com um aviso e a lista normal do Drive volta a aparecer.
  // A checagem de elementos só roda em Meu Drive e nas pastas: em outras seções (ex.: Computadores)
  // o Drive não tem os botões Lista/Grade nem as mesmas linhas, e isso não é defeito.

  const GUARD_MSG = {
    main: 'a área de arquivos do Drive não foi encontrada',
    toggle: 'os botões Lista/Grade do Drive não foram encontrados',
    rows: 'a lista de arquivos do Drive não pôde ser lida',
    nav: 'o Drive não abriu as pastas pedidas pelas colunas',
    error: 'a extensão encontrou erros repetidos',
  };
  const GUARD_WAIT = { main: 15000, toggle: 8000, rows: 6000 };
  const G = { key: null, since: {}, navFails: 0, errors: [] };

  function setHealth(v) {
    document.documentElement.dataset.gdfHealth = v;
  }

  function guardCheck() {
    if (!S.enabled || S.broken || !isFolderKey(S.key) || document.visibilityState !== 'visible') {
      G.since = {};
      return;
    }
    if (G.key !== S.key) {
      G.key = S.key;
      G.since = {};
    }
    const main = findMain();
    const N = S.nat;
    holds('main', !main);
    holds('toggle', !!main && !document.querySelector('.gdf-toggle'));
    // Há itens na área (elementos com data-id), mas nenhum no formato de linha que a extensão lê.
    holds('rows', !!main && N.key === S.key && N.settled && !N.failed
      && !nativeRows(nativeGrid(main)).length && !!main.querySelector('[data-id]'));
  }
  function holds(id, bad) {
    if (!bad) {
      delete G.since[id];
      return;
    }
    const now = Date.now();
    G.since[id] = G.since[id] || now;
    if (now - G.since[id] > GUARD_WAIT[id]) shutDown(id);
  }

  // Duas pastas seguidas que o Drive não abriu = a navegação pela URL parou de funcionar.
  function noteNav(ok) {
    if (ok) G.navFails = 0;
    else if (++G.navFails >= 2 && S.enabled) shutDown('nav');
  }

  function reportError(e, where) {
    console.error(`[GDrive macOS style] erro em ${where}:`, e);
    const now = Date.now();
    G.errors = G.errors.filter((t) => now - t < 20000);
    G.errors.push(now);
    if (G.errors.length >= 5 && S.enabled) shutDown('error', `${where}: ${(e && e.message) || e}`);
  }
  function guarded(where, fn) {
    return function (...args) {
      try {
        const r = fn.apply(this, args);
        if (r && typeof r.catch === 'function') r.catch((e) => reportError(e, where));
        return r;
      } catch (e) {
        reportError(e, where);
      }
    };
  }

  function shutDown(id, detail = '') {
    if (S.broken) return;
    S.broken = { id, msg: GUARD_MSG[id], detail };
    setHealth(id);
    console.warn(`[GDrive macOS style] Colunas desligadas: ${S.broken.msg}${detail ? ` (${detail})` : ''}.`);
    try {
      if (S.enabled) setEnabled(false);
    } catch (e) {
      console.error('[GDrive macOS style] erro ao desligar as colunas:', e);
      if (ui.root) ui.root.remove();
    }
    toast(`Colunas desligadas: ${S.broken.msg}. O Google pode ter mudado o Drive; a lista normal continua funcionando. Clique em Colunas para tentar de novo.`, 15000);
  }

  function resetGuard() {
    S.broken = null;
    G.since = {};
    G.navFails = 0;
    G.errors = [];
    setHealth('ok');
  }

  // ================================================================ autoteste
  //
  // Abre Meu Drive, liga as colunas e navega duas pastas, mostrando o resultado num painel.
  // Para rodar: abra https://drive.google.com/drive/my-drive#gdf-teste
  // (ou dispare document.dispatchEvent(new Event('gdf-selftest')) num teste automatizado).
  // O resultado também fica em <html data-gdf-test="ok|falhou"> e em data-gdf-test-report (JSON).

  const T = { running: false, panel: null };
  class TestFail extends Error {}
  const fail = (msg) => {
    throw new TestFail(msg);
  };

  async function selfTest() {
    if (T.running) return;
    T.running = true;
    const html = document.documentElement;
    html.dataset.gdfTest = 'rodando';
    const steps = [];
    const t0 = performance.now();
    const startKey = curKey();
    const wasEnabled = S.enabled;
    const render = () => renderTestPanel(steps, null);
    let failed = false;

    const step = async (label, fn) => {
      const s = { label, status: failed ? 'skip' : 'run', detail: failed ? 'não executado' : '', ms: 0 };
      steps.push(s);
      if (failed) return render();
      render();
      const t = performance.now();
      try {
        const r = await fn();
        s.status = r && r.skip ? 'skip' : 'ok';
        s.detail = (r && (r.detail || (typeof r === 'string' ? r : ''))) || '';
      } catch (e) {
        s.status = 'fail';
        s.detail = e instanceof TestFail ? e.message : `erro inesperado: ${e && e.message}`;
        failed = true;
      }
      s.ms = Math.round(performance.now() - t);
      render();
    };

    let skipSecond = false;
    await step('Abrir Meu Drive', async () => {
      if (!(await waitFor(findMain, 15000))) fail('área de arquivos (div[role="main"]) não encontrada');
      if (curKey() !== '/drive/my-drive') {
        navigateDrive('/drive/my-drive');
        if (!(await waitSettled('/drive/my-drive'))) fail('o Drive não abriu Meu Drive');
      }
      return pageTitle();
    });
    await step('Botão Colunas ao lado de Lista/Grade', async () => {
      if (!(await waitFor(() => document.querySelector('.gdf-toggle'), 8000))) {
        fail('botões Lista/Grade (button[data-test-id="list-layout-button"]) não encontrados');
      }
    });
    await step('Ligar as colunas', async () => {
      if (S.broken) resetGuard();
      S.needsBuild = true;
      if (S.enabled) update();
      else setEnabled(true);
      const built = () => isShowing() && !S.needsBuild && S.cols[0] && S.cols[0].key === '/drive/my-drive';
      if (!(await waitFor(built, 3000))) fail('as colunas não apareceram');
    });
    await step('Ler os itens de Meu Drive', async () => {
      const c = S.cols[0];
      await waitFor(() => S.broken || c.error || (c.items && c.items.length), 12000);
      if (S.broken) fail(S.broken.msg);
      if (c.error) fail('o Drive não abriu a pasta');
      if (!c.items || !c.items.length) fail('nenhum item lido da lista do Drive (tr[role="row"][data-id])');
      if (c.items.every((i) => !i.name)) fail('itens sem nome (o Drive mudou onde mostra o nome)');
      const nf = c.items.filter((i) => i.isFolder).length;
      return `${plural(c.items.length, '1 item', '# itens')}, ${plural(nf, '1 pasta', '# pastas')}`;
    });
    const openFolderIn = async (ci) => {
      const c = S.cols[ci];
      if (!c || !c.items) fail('coluna anterior não está aberta');
      const f = c.items.find((i) => i.isFolder && !i.isShortcut);
      if (!f) {
        skipSecond = true;
        return { skip: true, detail: ci === 0 ? 'nenhuma pasta reconhecida (se houver pastas, a detecção quebrou)' : 'a pasta não tem subpastas' };
      }
      selectIds(ci, [f.id]);
      const next = S.cols[ci + 1];
      if (!next) fail(`a coluna de “${f.name}” não foi criada`);
      const ok = await waitFor(() => S.broken || next.error
        || (next.items && curKey() === next.key && S.nat.key === next.key && S.nat.settled), 15000);
      if (S.broken) fail(S.broken.msg);
      if (!ok) fail(`“${f.name}” não carregou em 15 s`);
      if (next.error) fail(`o Drive não abriu “${f.name}”`);
      return `“${f.name}”: ${plural(next.items.length, '1 item', '# itens')}`;
    };
    await step('Abrir a 1ª pasta', () => openFolderIn(0));
    await step('Abrir uma pasta dentro dela', () => (skipSecond ? { skip: true, detail: 'sem pasta para abrir' } : openFolderIn(1)));
    await step('Nenhum alerta da proteção', () => {
      if (S.broken) fail(S.broken.msg);
    });

    // Devolve o Drive como estava.
    if (!wasEnabled && S.enabled) setEnabled(false);
    if (!wasEnabled && curKey() !== startKey) navigateDrive(startKey);

    const ok = !steps.some((s) => s.status === 'fail');
    const total = Math.round(performance.now() - t0);
    html.dataset.gdfTest = ok ? 'ok' : 'falhou';
    html.dataset.gdfTestReport = JSON.stringify({ ok, ms: total, steps });
    console.info(`[GDrive macOS style] autoteste: ${ok ? 'OK' : 'FALHOU'} em ${(total / 1000).toFixed(1)} s`);
    console.table(steps.map((s) => ({ etapa: s.label, resultado: s.status, detalhe: s.detail, ms: s.ms })));
    renderTestPanel(steps, { ok, ms: total });
    T.running = false;
  }

  function renderTestPanel(steps, done) {
    const MARK = { run: '…', ok: '✓', fail: '✕', skip: '–' };
    if (!T.panel || !T.panel.isConnected) {
      T.panel = h('div', { class: 'gdf-test', role: 'status' });
      ui.layer.append(T.panel);
    }
    const sum = !done ? 'Testando…'
      : done.ok ? `Tudo certo em ${(done.ms / 1000).toFixed(1).replace('.', ',')} s`
      : `Falhou: ${(steps.find((s) => s.status === 'fail') || {}).label}`;
    T.panel.replaceChildren(
      h('div', { class: 'gdf-test-head' }, 'Autoteste — GDrive macOS style'),
      h('ol', { class: 'gdf-test-steps' }, steps.map((s) => h('li', { class: 'is-' + s.status },
        h('span', { class: 'gdf-test-mark' }, MARK[s.status]),
        h('span', { class: 'gdf-test-txt' },
          h('span', null, s.label),
          s.detail ? h('span', { class: 'gdf-test-detail' }, s.detail) : null),
        s.ms ? h('span', { class: 'gdf-test-ms' }, s.ms < 1000 ? `${s.ms} ms` : `${(s.ms / 1000).toFixed(1).replace('.', ',')} s`) : null))),
      h('div', { class: 'gdf-test-foot' + (done ? (done.ok ? ' is-ok' : ' is-fail') : '') },
        h('span', null, sum),
        done ? h('span', { class: 'gdf-test-btns' },
          h('button', { class: 'gdf-test-btn', onclick: () => selfTest() }, 'Rodar de novo'),
          h('button', { class: 'gdf-test-btn', onclick: () => T.panel.remove() }, 'Fechar')) : null));
  }

  function maybeTestFromHash() {
    if (!TEST_HASH.test(location.hash)) return false;
    history.replaceState(history.state, '', location.pathname + location.search);
    return true;
  }

  // ================================================================ boot

  function throttle(fn, ms) {
    let t = 0;
    return () => {
      if (t) return;
      t = setTimeout(() => {
        t = 0;
        fn();
      }, ms);
    };
  }

  function start() {
    buildUi();
    document.body.append(ui.layer);
    setHealth('ok');
    const safeToggle = guarded('botão', injectToggle);
    const safeTick = guarded('tick', tick);
    new MutationObserver(throttle(safeToggle, 150)).observe(document.body, { childList: true, subtree: true });
    safeToggle();
    safeTick();
    setInterval(safeTick, 250);
    document.addEventListener('gdf-selftest', () => selfTest());
    window.addEventListener('hashchange', () => maybeTestFromHash() && selfTest());
    if (WANT_TEST) setTimeout(selfTest, 0);
    window.addEventListener('resize', layout);
    // Se o Drive focar a lista escondida (ao selecionarmos itens nela), devolve o foco às colunas.
    document.addEventListener('focusin', (e) => {
      if (!isShowing() || !S.wantFocus) return;
      const main = findMain();
      if (main && main.contains(e.target)) focusRoot();
    }, true);
    // Clicar em menus/diálogos nativos (abertos a partir das colunas) não tira o foco das colunas.
    window.addEventListener('mousedown', (e) => {
      const t = e.target;
      if (S.firing || ui.root.contains(t)) return;
      if (t.closest && t.closest('[role="menu"], [role="menuitem"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      S.wantFocus = false;
    }, true);
  }

  // Tira o #gdf-teste da URL antes de o Drive iniciar (o teste em si roda no start()).
  if (WANT_TEST) maybeTestFromHash();

  Promise.resolve()
    .then(() => (EXT ? EXT.storage.sync.get(['gdfEnabled', 'gdfColW', 'gdfPathMode']) : {}))
    .catch(() => ({}))
    .then((v) => {
      S.enabled = !!(v && v.gdfEnabled);
      S.initialBuild = S.enabled; // colunas já ligadas na carga: esta primeira construção usa pathMode
      S.pathMode = v?.gdfPathMode === 'full' ? 'full' : 'folder';
      S.colW = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Number(v && v.gdfColW) || DEFAULT_COL_W));
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    });

  // A opção Pasta/Caminho fica na página de opções da extensão (options.html).
  try {
    EXT?.storage?.onChanged?.addListener((ch, area) => {
      if (area === 'sync' && ch.gdfPathMode) S.pathMode = ch.gdfPathMode.newValue === 'full' ? 'full' : 'folder';
    });
  } catch {
    /* contexto da extensão invalidado */
  }
})();
