// Local-only autosave: a single "current draft" record in IndexedDB, so a
// closed tab can be picked back up like a Google Docs draft. Nothing leaves
// the browser.

const DB_NAME = 'pdf-resume-editor';
const STORE = 'drafts';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveDraft(draft) {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.put(draft, KEY));
}

export async function loadDraft() {
  if (typeof indexedDB === 'undefined') return null;
  let result;
  await withStore('readonly', (store) => {
    const req = store.get(KEY);
    req.onsuccess = () => { result = req.result; };
  });
  return result || null;
}

export async function clearDraft() {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.delete(KEY));
}
