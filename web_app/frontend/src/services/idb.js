const DB_NAME = 'LocusKeyframeDB';
const STORE_NAME = 'keyframes';
const DB_VERSION = 1;

let dbInstance = null;

export const initDB = () => {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => reject('IndexedDB error: ' + e.target.error);

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'keyframe_id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('medication_detected', 'medication_detected', { unique: false });
      }
    };
  });
};

export const saveKeyframes = async (keyframes) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    keyframes.forEach(kf => {
      store.put(kf);
    });

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};

export const getKeyframes = async ({ limit = 200, medication_only = false } = {}) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    
    // Sort descending by timestamp
    const request = index.openCursor(null, 'prev');
    const results = [];

    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        const kf = cursor.value;
        if (!medication_only || kf.medication_detected) {
          results.push(kf);
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };

    request.onerror = (e) => reject(e.target.error);
  });
};

export const getKeyframeById = async (id) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
};

export const deleteKeyframes = async (ids) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    ids.forEach(id => store.delete(id));

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
};
