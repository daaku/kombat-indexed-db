import { Remote, SyncDB } from '@daaku/kombat'
import {
  ChangeListener,
  loadDatasetMem,
  LocalIndexedDB,
  syncDatasetMem,
} from './index.js'
import { dequal } from 'dequal'
import { IDBPDatabase, openDB } from 'idb'

export interface Opts {
  readonly dbName: string
  readonly remote: Remote
}

// Store provides the DB, that proxy to your various datasets.
export interface Store<DB extends object> {
  // Your datasets, containing the the rows of data.
  readonly db: DB

  // Listen to changes on the data.
  listenChanges(cb: ChangeListener): () => void

  // Settle ensures all background async writes have submitted to the underlying
  // SyncDB. This is important because the proxy provides a synchronous API on
  // what is underneath an asynchronous API.
  settle(): Promise<void>

  // Close the underlying IndexedDB instance. Using the Store after
  // closing it will result in errors.
  close(): void
}

const isPrimitive = (v: unknown) => {
  if (typeof v === 'object') {
    return v === null
  }
  return typeof v !== 'function'
}

class DBProxy {
  #store: TheStore<any>
  constructor(s: TheStore<any>) {
    this.#store = s
  }
  get(_: unknown, dataset: string) {
    return this.#store.datasetProxy(dataset)
  }
  set(): any {
    throw new TypeError('cannot set on DB')
  }
  deleteProperty(): any {
    throw new TypeError('cannot delete on DB')
  }
  ownKeys() {
    return Object.keys(this.#store.mem)
  }
  has(_: unknown, dataset: string) {
    return dataset in this.#store.mem
  }
  defineProperty(): any {
    throw new TypeError('cannot defineProperty on DB')
  }
  getOwnPropertyDescriptor(_: unknown, p: string) {
    return {
      value: this.#store.datasetProxy(p),
      writable: true,
      enumerable: true,
      configurable: true,
    }
  }
}

class DatasetProxy {
  #store: TheStore<any>
  #dataset: string
  constructor(s: TheStore<any>, dataset: string) {
    this.#store = s
    this.#dataset = dataset
  }
  #getDataset(): any {
    let dataset = this.#store.mem[this.#dataset]
    if (!dataset) {
      dataset = this.#store.mem[this.#dataset] = {}
    }
    return dataset
  }
  get(target: unknown, id: string) {
    if (this.has(target, id)) {
      return new Proxy({}, new RowProxy(this.#store, this.#dataset, id))
    }
  }
  set(_: unknown, id: string, value: any): any {
    if (typeof value !== 'object') {
      throw new Error(
        `cannot use non object value in dataset "${
          this.#dataset
        }" with row id "${id}"`,
      )
    }

    // work with a clone, since we may modify it
    value = structuredClone(value)

    // ensure we have an ID and it is what we expect
    if ('id' in value) {
      if (id !== value.id) {
        const valueID = value.id
        throw new Error(
          `id mismatch in dataset "${
            this.#dataset
          }" with row id "${id}" and valud id ${valueID}`,
        )
      }
    } else {
      value.id = id
    }

    const dataset = this.#getDataset()

    // only send messages for changed values.
    const existing = dataset[id] ?? {}
    this.#store.send(
      // @ts-expect-error typescript doesn't understand filter
      [
        // update changed properties
        ...Object.entries(value)
          .map(([k, v]) => {
            if (existing && dequal(existing[k], v)) {
              return
            }
            return {
              dataset: this.#dataset,
              row: id,
              column: k,
              value: v,
            }
          })
          .filter(v => v),
        // drop missing properties
        ...Object.keys(existing)
          .map(k => {
            if (k in value) {
              return
            }
            return {
              dataset: this.#dataset,
              row: id,
              column: k,
              value: undefined,
            }
          })
          .filter(v => v),
      ],
    )
    // synchronously update our in-memory dataset.
    dataset[id] = value
    return true
  }
  deleteProperty(_: unknown, id: string): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: id,
        column: 'tombstone',
        value: true,
      },
    ])
    const dataset = this.#getDataset()
    if (id in dataset) {
      dataset[id].tombstone = true
    } else {
      dataset[id] = { tombstone: true }
    }
    return true
  }
  ownKeys() {
    const dataset = this.#getDataset()
    return Object.keys(dataset).filter(r => !dataset[r].tombstone)
  }
  has(_: unknown, id: string) {
    const row = this.#store.mem[this.#dataset]?.[id]
    return row && !row.tombstone
  }
  defineProperty(): any {
    throw new TypeError(`cannot defineProperty on dataset "${this.#dataset}"`)
  }
  getOwnPropertyDescriptor(target: unknown, id: string) {
    const value = this.get(target, id)
    if (value) {
      return {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      }
    }
  }
}

class RowProxy {
  #store: TheStore<any>
  #dataset: string
  #id: string
  constructor(store: TheStore<any>, dataset: string, id: string) {
    this.#store = store
    this.#dataset = dataset
    this.#id = id
  }
  get(_: unknown, prop: string) {
    const row = this.#store.mem[this.#dataset]?.[this.#id]
    if (!row) {
      return
    }
    const val = row[prop]
    // hasOwn allows pass-thru of prototype properties like constructor
    if (isPrimitive(val) || !Object.hasOwn(row, prop)) {
      return val
    }
    throw new Error(
      `non primitive value for dataset "${this.#dataset}" row with id "${
        this.#id
      }" and property "${prop}" of type "${typeof val}" and value "${val}"`,
    )
  }
  set(_: any, prop: string, value: unknown): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: value,
      },
    ])
    let dataset = this.#store.mem[this.#dataset]
    if (!dataset) {
      dataset = this.#store.mem[this.#dataset] = {}
    }
    let row = dataset[this.#id]
    if (!row) {
      row = dataset[this.#id] = { id: this.#id }
    }
    row[prop] = value
    return true
  }
  deleteProperty(_: unknown, prop: string): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: undefined,
      },
    ])
    delete this.#store.mem[this.#dataset]?.[this.#id]?.[prop]
    return true
  }
  ownKeys() {
    const row = this.#store.mem[this.#dataset]?.[this.#id]
    return row ? Object.keys(row) : []
  }
  has(_: unknown, p: string) {
    const row = this.#store.mem[this.#dataset]?.[this.#id]
    return row ? p in row : false
  }
  defineProperty(): any {
    throw new TypeError(
      `cannot defineProperty on dataset "${this.#dataset}" with row id ${
        this.#id
      }`,
    )
  }
  getOwnPropertyDescriptor(target: unknown, prop: string) {
    const value = this.get(target, prop)
    if (value) {
      return {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      }
    }
  }
}

// TheStore is the internal concrete implementation which is returned. The
// TypeScript API is limited by the interface it implements. The other bits are
// for internal consumption.
class TheStore<DB extends object> implements Store<DB> {
  readonly #dbProxy: ProxyHandler<DB>
  readonly #pending: Set<Promise<void>> = new Set()
  readonly #datasetProxies: Record<string, ProxyHandler<Record<string, any>>> =
    {}
  readonly #idb: IDBPDatabase
  readonly #local: LocalIndexedDB
  readonly syncDB: SyncDB
  mem: any

  private constructor(
    idb: IDBPDatabase,
    local: LocalIndexedDB,
    syncDB: SyncDB,
    mem: any,
  ) {
    this.#idb = idb
    this.#local = local
    this.syncDB = syncDB
    this.mem = mem
    this.#dbProxy = new Proxy({}, new DBProxy(this))
  }

  static async new(opts: Opts) {
    const mem = {}

    const local = new LocalIndexedDB()
    local.listenChanges(syncDatasetMem(mem))
    const idb = await openDB(opts.dbName, 1, {
      upgrade: db => local.upgradeDB(db),
      blocking: () => idb.close(),
    })
    await loadDatasetMem(mem, idb)
    local.setDB(idb)

    const syncDB = await SyncDB.new(opts.remote, local)
    const store = new TheStore(idb, local, syncDB, mem)

    // start initial sync, and make it pending for settle
    const r = syncDB.sync()
    store.#pending.add(r)
    r.finally(() => store.#pending.delete(r))

    return store
  }

  close() {
    this.#idb?.close()
    this.mem = null
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.#pending.values())
    await this.syncDB.settle()
  }

  listenChanges(cb: ChangeListener): () => void {
    return this.#local.listenChanges(cb)
  }

  get db(): DB {
    // @ts-expect-error type bypass
    return this.#dbProxy
  }

  datasetProxy(dataset: string) {
    let proxy = this.#datasetProxies[dataset]
    if (!proxy) {
      this.#datasetProxies[dataset] = proxy = new Proxy(
        {},
        new DatasetProxy(this, dataset),
      )
    }
    return proxy
  }

  // wrap the syncDB send and hold on to the promises until they settle,
  // allowing callers to let things settle.
  send(...args: Parameters<SyncDB['send']>) {
    const r = this.syncDB.send(...args)
    this.#pending.add(r)
    r.finally(() => this.#pending.delete(r))
  }
}

export const initStore = <DB extends object>(opts: Opts): Promise<Store<DB>> =>
  // @ts-expect-error type bypass
  TheStore.new(opts)
