const perOriginLimit = 150;
const totalLimit = 750;

export function openRequestStore() {
  const open = indexedDB.open('mockend-requests', 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('requests', { keyPath: 'id', autoIncrement: true }).createIndex('origin', 'origin');
    db.createObjectStore('views');
  };
  return result(open).then(db => ({
    load: origin => Promise.all([
      result(db.transaction('requests').objectStore('requests').index('origin').getAll(origin)),
      result(db.transaction('views').objectStore('views').get(origin))
    ]),
    async add(origin, entry) {
      const store = db.transaction('requests', 'readwrite').objectStore('requests');
      const id = await result(store.add({ origin, entry }));
      const prune = (request, limit) => request.onsuccess = () => {
        for (const key of request.result.slice(0, -limit)) store.delete(key);
      };
      prune(store.index('origin').getAllKeys(origin), perOriginLimit);
      prune(store.getAllKeys(), totalLimit);
      return id;
    },
    async body(id, body) {
      const store = db.transaction('requests', 'readwrite').objectStore('requests');
      const row = await result(store.get(id));
      if (row) await result(store.put({ ...row, body }));
    },
    async clear(ids) {
      const store = db.transaction('requests', 'readwrite').objectStore('requests');
      await Promise.all(ids.map(id => result(store.delete(id))));
    },
    saveView: (origin, view) => result(db.transaction('views', 'readwrite').objectStore('views').put(view, origin))
  }));
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
