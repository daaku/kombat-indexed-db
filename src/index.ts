import { IDBPDatabase } from 'idb';
import type { Local, Message } from '@daaku/kombat';

const lastSyncKey = 'last_sync';

function latestMessageKey(msg: Message): string {
  return `${msg.dataset}:${msg.row}:${msg.column}`;
}

export class LocalIndexedDB implements Local {
  private db!: IDBPDatabase;
  private readonly messageLogStoreName: string;
  private readonly latestMessageStoreName: string;
  private readonly messageMetaStoreName: string;

  // Construct a LocalIndexedDB instance.
  constructor(internalPrefix = '', private datasetPrefix = '') {
    this.messageLogStoreName = `${internalPrefix}message_log`;
    this.latestMessageStoreName = `${internalPrefix}message_latest`;
    this.messageMetaStoreName = `${internalPrefix}message_meta`;
  }

  private datasetStoreName(name: string): string {
    return `${this.datasetPrefix}${name}`;
  }

  // This method should be called in your upgrade callback.
  public upgradeDB(db: IDBPDatabase): void {
    if (db.objectStoreNames.contains(this.messageLogStoreName)) {
      return;
    }
    db.createObjectStore(this.messageLogStoreName, { keyPath: 'timestamp' });
    db.createObjectStore(this.latestMessageStoreName);
    db.createObjectStore(this.messageMetaStoreName);
  }

  // This should be called with the initialized DB before you begin using the
  // instance.
  public setDB(db: IDBPDatabase): void {
    this.db = db;
  }

  public async applyChanges(messages: Message[]): Promise<void> {
    // consolidate the changes by dataset as well as row id.
    // consolidating by row id is important because if we have multiple changes
    // to the same row we will not read changes made within the transaction,
    // there by causing only the last write to survive.
    const changes: {
      [key: string]: { [key: string]: { [key: string]: unknown } };
    } = {};
    messages.map((msg) => {
      const datasetName = this.datasetStoreName(msg.dataset);
      let dataset = changes[datasetName];
      if (!dataset) {
        dataset = changes[datasetName] = {};
      }
      let row = dataset[msg.row];
      if (!row) {
        row = dataset[msg.row] = {};
      }
      row[msg.column] = msg.value;
    });

    const t = this.db.transaction(Object.keys(changes), 'readwrite');
    await Promise.all(
      Object.keys(changes).map(async (dataset) => {
        const store = t.objectStore(dataset);
        await Object.keys(changes[dataset]).map(async (id) => {
          let row = await store.get(id);
          if (!row) {
            row = { id, ...changes[dataset][id] };
          } else {
            row = { ...row, ...changes[dataset][id] };
          }
          await store.put(row);
        });
      }),
    );
    await t.done;
  }

  public async storeMessages(messages: Message[]): Promise<boolean[]> {
    const t = this.db.transaction(
      [this.messageLogStoreName, this.latestMessageStoreName],
      'readwrite',
    );
    const messageLogStore = t.objectStore(this.messageLogStoreName);
    const latestMessageStore = t.objectStore(this.latestMessageStoreName);
    const results = await Promise.all(
      messages.map(async (msg) => {
        const row = await messageLogStore.get(msg.timestamp);
        if (!row) {
          await messageLogStore.put(msg);

          // just stored a new message, update latestMessage if necessary
          const key = latestMessageKey(msg);
          const existingLatest: Message = await latestMessageStore.get(key);
          if (!existingLatest || existingLatest.timestamp < msg.timestamp) {
            await latestMessageStore.put(msg, key);
          }
        }
        return !row;
      }),
    );
    await t.done;
    return results;
  }

  public async queryMessages(since: string): Promise<Message[]> {
    const t = this.db.transaction(this.messageLogStoreName);
    const results: Message[] = [];
    let cursor = await t.store.openCursor(
      IDBKeyRange.lowerBound(since),
      'prev',
    );
    while (cursor) {
      results.push(cursor.value);
      cursor = await cursor.continue();
    }
    await t.done;
    return results;
  }

  public async queryLatestMessages(
    messages: Message[],
  ): Promise<(Message | undefined)[]> {
    const t = this.db.transaction(this.latestMessageStoreName);
    const results = await Promise.all(
      messages.map((msg) => t.store.get(latestMessageKey(msg))),
    );
    await t.done;
    return results;
  }

  public async storeLastSync(timestamp: string): Promise<void> {
    await this.db.put(this.messageMetaStoreName, timestamp, lastSyncKey);
  }

  public async queryLastSync(): Promise<string | undefined> {
    return await this.db.get(this.messageMetaStoreName, lastSyncKey);
  }
}
