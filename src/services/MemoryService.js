import { openDB } from 'idb';

const DB_NAME = 'liya-memory-db';
const DB_VERSION = 2;
const STORE_NAME = 'memories';

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion, newVersion, transaction) {
    if (oldVersion < 1) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      store.createIndex('content', 'content', { unique: false });
      store.createIndex('timestamp', 'timestamp', { unique: false });
      store.createIndex('tags', 'tags', { multiEntry: true });
      store.createIndex('userId', 'userId', { unique: false });
    } else if (oldVersion < 2) {
      const store = transaction.objectStore(STORE_NAME);
      if (!store.indexNames.contains('userId')) {
        store.createIndex('userId', 'userId', { unique: false });
      }
    }
  },
});

export const MemoryService = {
  /**
   * Store a new memory chunk
   * @param {string} content - The memory text
   * @param {string} userId - The user ID from env
   * @param {string[]} tags - Optional tags for categorization
   */
  async addMemory(content, userId, tags = []) {
    const db = await dbPromise;
    return db.add(STORE_NAME, {
      content,
      userId,
      tags,
      timestamp: Date.now()
    });
  },

  /**
   * Search memories by keyword and user
   * @param {string} query - Keyword to search for
   * @param {string} userId - The user ID from env
   */
  async searchMemories(query, userId) {
    const db = await dbPromise;
    const all = await db.getAll(STORE_NAME);
    const lowerQuery = query.toLowerCase();
    
    return all.filter(m => 
      m.userId === userId && 
      (m.content.toLowerCase().includes(lowerQuery) || 
       m.tags.some(t => t.toLowerCase().includes(lowerQuery)))
    ).sort((a, b) => b.timestamp - a.timestamp);
  },

  /**
   * Get recent memories for a user
   * @param {string} userId - The user ID from env
   * @param {number} limit - Max number of items
   */
  async getRecentMemories(userId, limit = 10) {
    const db = await dbPromise;
    const all = await db.getAll(STORE_NAME);
    return all.filter(m => m.userId === userId)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, limit);
  },

  /**
   * Clear all memories
   */
  async clearAll() {
    const db = await dbPromise;
    return db.clear(STORE_NAME);
  }
};
