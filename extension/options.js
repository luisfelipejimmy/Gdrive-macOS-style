// Página de opções: guarda a preferência Pasta/Caminho em storage.sync (lida pelo content.js).
const radios = [...document.querySelectorAll('input[name="pathMode"]')];
const saved = document.getElementById('saved');
let hideT = 0;

chrome.storage.sync.get('gdfPathMode').then((v) => {
  const mode = v.gdfPathMode === 'full' ? 'full' : 'folder';
  for (const r of radios) r.checked = r.value === mode;
});

for (const r of radios) {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    await chrome.storage.sync.set({ gdfPathMode: r.value });
    saved.textContent = 'Salvo. Vale na próxima vez que uma pasta for aberta pelo link.';
    clearTimeout(hideT);
    hideT = setTimeout(() => (saved.textContent = ''), 4000);
  });
}
