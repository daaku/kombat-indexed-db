import type { Local, Message } from '@daaku/kombat'
import { IDBPDatabase } from 'idb'

function latestMessageKey(msg: Message): string {
  return `${msg.dataset}:${msg.row}:${msg.column}`
}

// Changes are keyed by dataset, then row ID, then column mapped to value.
export interface Changes {
  [key: string]: {
    [key: string]: {
      [key: string]: unknown
    }
  }
}

export type ChangeListener = { (changes: Changes): void }

export function syncDatasetIndexedDB(
  db: IDBPDatabase,
  prefix = '',
): ChangeListener {
  const dsName = (name: string) => `${prefix}${name}`
  return async (changes: Changes) => {
    const storeNames = Object.keys(changes).map(dsName)
    const t = db.transaction(storeNames, 'readwrite')
    await Promise.all(
      Object.keys(changes).map(async dataset => {
        const store = t.objectStore(dsName(dataset))
        await Object.keys(changes[dataset]).map(async id => {
          let row = await store.get(id)
          if (!row) {
            row = { id, ...changes[dataset][id] }
          } else {
            row = { ...row, ...changes[dataset][id] }
          }
          await store.put(row)
        })
      }),
    )
    await t.done
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function syncDatasetMem(mem: any): ChangeListener {
  return async (changes: Changes) => {
    Object.keys(changes).map(datasetName => {
      let dataset = mem[datasetName]
      if (!dataset) {
        mem[datasetName] = dataset = {}
      }
      Object.keys(changes[datasetName]).map(id => {
        let row = dataset[id]
        if (!row) {
          row = { id, ...changes[datasetName][id] }
        } else {
          row = { ...row, ...changes[datasetName][id] }
        }
        dataset[id] = row
      })
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadDatasetMem(mem: any, db: IDBPDatabase, prefix = '') {
  ;(await db.getAll(`${prefix}message_latest`)).forEach(
    ({ dataset, row, column, value }) => {
      let d = mem[dataset]
      if (!d) {
        d = mem[dataset] = {}
      }
      let r = d[row]
      if (!r) {
        r = d[row] = { id: row }
      }
      r[column] = value
    },
  )
}

export class LocalIndexedDB implements Local {
  #db!: IDBPDatabase
  readonly #messageLogStoreName: string
  readonly #latestMessageStoreName: string
  readonly #messageMetaStoreName: string
  #changeListeners: ChangeListener[] = []

  // Construct a LocalIndexedDB instance.
  constructor(internalPrefix = '') {
    this.#messageLogStoreName = `${internalPrefix}message_log`
    this.#latestMessageStoreName = `${internalPrefix}message_latest`
    this.#messageMetaStoreName = `${internalPrefix}message_meta`
  }

  // Add a listener for changes. Returned function can be called to unsubscribe.
  public listenChanges(cb: ChangeListener): () => void {
    this.#changeListeners.push(cb)
    return () => {
      this.#changeListeners = this.#changeListeners.filter(e => e != cb)
    }
  }

  // This method should be called in your upgrade callback.
  public upgradeDB(db: IDBPDatabase): void {
    if (!db.objectStoreNames.contains(this.#messageLogStoreName)) {
      db.createObjectStore(this.#messageLogStoreName, { keyPath: 'timestamp' })
    }
    ;[this.#latestMessageStoreName, this.#messageMetaStoreName].forEach(
      name => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      },
    )
  }

  // This should be called with the initialized DB before you begin using the
  // instance.
  public setDB(db: IDBPDatabase): void {
    this.#db = db
  }

  public async applyChanges(messages: Message[]): Promise<void> {
    // consolidate the changes by dataset as well as row id.
    // consolidating by row id is important because if we have multiple changes
    // to the same row we will not read changes made within the transaction,
    // there by causing only the last write to survive.
    const changes: Changes = {}
    messages.map(msg => {
      let dataset = changes[msg.dataset]
      if (!dataset) {
        dataset = changes[msg.dataset] = {}
      }
      let row = dataset[msg.row]
      if (!row) {
        row = dataset[msg.row] = {}
      }
      row[msg.column] = msg.value
    })
    this.#changeListeners.forEach(c => c(changes))
  }

  public async storeMessages(messages: Message[]): Promise<boolean[]> {
    const t = this.#db.transaction(
      [this.#messageLogStoreName, this.#latestMessageStoreName],
      'readwrite',
    )
    const messageLogStore = t.objectStore(this.#messageLogStoreName)
    const latestMessageStore = t.objectStore(this.#latestMessageStoreName)
    const results = await Promise.all(
      messages.map(async msg => {
        const row = await messageLogStore.get(msg.timestamp)
        if (!row) {
          await messageLogStore.put(msg)

          // just stored a new message, update latestMessage if necessary
          const key = latestMessageKey(msg)
          const existingLatest: Message = await latestMessageStore.get(key)
          if (!existingLatest || existingLatest.timestamp < msg.timestamp) {
            await latestMessageStore.put(msg, key)
          }
        }
        return !row
      }),
    )
    await t.done
    return results
  }

  public async queryMessages(since: string): Promise<Message[]> {
    const t = this.#db.transaction(this.#messageLogStoreName)
    const results: Message[] = []
    let cursor = await t.store.openCursor(IDBKeyRange.lowerBound(since), 'prev')
    while (cursor) {
      results.push(cursor.value)
      cursor = await cursor.continue()
    }
    await t.done
    return results
  }

  public async queryLatestMessages(
    messages: Message[],
  ): Promise<(Message | undefined)[]> {
    const t = this.#db.transaction(this.#latestMessageStoreName)
    const results = await Promise.all(
      messages.map(msg => t.store.get(latestMessageKey(msg))),
    )
    await t.done
    return results
  }

  public async set(key: string, value: string): Promise<void> {
    await this.#db.put(this.#messageMetaStoreName, value, key)
  }

  public async get(key: string): Promise<string | undefined> {
    return await this.#db.get(this.#messageMetaStoreName, key)
  }
}
