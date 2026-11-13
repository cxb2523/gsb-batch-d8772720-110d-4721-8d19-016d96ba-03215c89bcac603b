import { openDB } from 'idb';

const DB_NAME = 'LIYA_DATABASE';
const STORE_NAME = 'sessions';
const VERSION = 2;

let dbPromise = null;
const userId = import.meta.env.VITE_USER_NAME || "Navraj";

export const initDB = async () => {
    if (dbPromise) return dbPromise;
    dbPromise = openDB(DB_NAME, VERSION, {
        upgrade(db, oldVersion, newVersion, transaction) {
            if (oldVersion < 1) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
            if (oldVersion < 2) {
                const store = transaction.objectStore(STORE_NAME);
                if (!store.indexNames.contains('userId')) {
                    store.createIndex('userId', 'userId', { unique: false });
                }
            }
        },
    });
    return dbPromise;
};

export const saveSession = async (session) => {
    const db = await initDB();
    return db.put(STORE_NAME, { ...session, userId });
};

export const getAllSessions = async () => {
    const db = await initDB();
    const all = await db.getAll(STORE_NAME);
    return all.filter(s => s.userId === userId);
};

export const deleteSessionFromDB = async (id) => {
    const db = await initDB();
    return db.delete(STORE_NAME, id);
};

export const clearAllSessions = async () => {
    const db = await initDB();
    const all = await db.getAll(STORE_NAME);
    const userSessions = all.filter(s => s.userId === userId);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (const session of userSessions) {
        tx.store.delete(session.id);
    }
    await tx.done;
};

export const getStorageStats = async () => {
    if (!navigator.storage || !navigator.storage.estimate) return { usage: 0, quota: 0 };
    const estimate = await navigator.storage.estimate();
    return {
        usage: (estimate.usage / (1024 * 1024)).toFixed(2), // MB
        quota: (estimate.quota / (1024 * 1024)).toFixed(2)  // MB
    };
};
