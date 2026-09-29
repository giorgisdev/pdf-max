// Local-only autosave: one record per document in IndexedDB (keyed by docId),
// keeping the most recent few so a closed tab can be picked back up like a
// Google Docs "Recent documents" list. Nothing leaves the browser.

const DB_NAME = 'pdf-resume-editor';
const STORE = 'drafts';
const MAX_DRAFTS = 3;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const store = e.oldVersion < 1
        ? db.createObjectStore(STORE)
        : req.transaction.objectStore(STORE);
      // v1 kept a single record under "current"; move it to a per-document key.
      if (e.oldVersion === 1) {
        const get = store.get('current');
        get.onsuccess = () => {
          const old = get.result;
          if (old) {
            old.docId = crypto.randomUUID();
            store.put(old, old.docId);
          }
          store.delete('current');
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function saveDraft(draft) {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => {
    store.put(draft, draft.docId);
    // Prune to the newest MAX_DRAFTS records (savedAt only, bytes are read anyway).
    const req = store.getAll();
    req.onsuccess = () => {
      req.result
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(MAX_DRAFTS)
        .forEach((d) => store.delete(d.docId));
    };
  });
}

export async function listDrafts() {
  if (typeof indexedDB === 'undefined') return [];
  let result = [];
  await withStore('readonly', (store) => {
    const req = store.getAll();
    req.onsuccess = () => { result = req.result; };
  });
  return result.filter((d) => d?.docId).sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadDraft(docId) {
  if (typeof indexedDB === 'undefined') return null;
  let result;
  await withStore('readonly', (store) => {
    const req = store.get(docId);
    req.onsuccess = () => { result = req.result; };
  });
  return result || null;
}

export async function deleteDraft(docId) {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.delete(docId));
}
