import QUnit from 'qunit'
import 'qunit/qunit/qunit.css'
import { Remote, SyncRequest } from '@daaku/kombat'
import { initStore, Store } from '../src/store.js'
import { deleteDB } from 'idb'
import { Changes } from '@daaku/kombat-indexed-db'

interface Jedi {
  id?: string
  name: string
  age?: number
}

interface Sith {
  id?: string
  name: string
  convert: boolean
}

interface DB {
  jedi: Record<string, Jedi>
  sith: Record<string, Sith>
}

const yoda = Object.freeze({ name: 'yoda', age: 942 })
const vader = Object.freeze({ name: 'vader', convert: true })

const noOpRemote: Remote = {
  async sync(req: SyncRequest): Promise<SyncRequest> {
    return { merkle: req.merkle, messages: [] }
  },
}

declare global {
  interface Assert {
    id: string
    store: Store<DB>
  }
}

QUnit.hooks.beforeEach(async assert => {
  assert.id = QUnit.config.current.testName
    .toLowerCase()
    .replaceAll(/[^a-z]/g, '_')
  await deleteDB(assert.id)
  assert.store = await initStore<DB>({
    dbName: assert.id,
    remote: noOpRemote,
  })
})

QUnit.hooks.afterEach(async assert => {
  await assert.store.settle()
  await deleteDB(assert.id)
})

QUnit.test('DBProxy: Cannot Set Property', async assert => {
  assert.throws(() => {
    assert.store.db.jedi = { yoda }
  }, /cannot set/)
})

QUnit.test('DBProxy: Cannot Delete Property', async assert => {
  assert.throws(() => {
    // @ts-expect-error asserting invalid behavior throws
    delete assert.store.db.jedi
  }, /cannot delete/)
})

QUnit.test('DBProxy: Cannot defineProperty', async assert => {
  assert.throws(() => {
    Object.defineProperty(assert.store.db, 'answer', {
      value: 42,
      writable: false,
    })
  }, /cannot define/)
})

QUnit.test('DatasetProxy: Cannot defineProperty', async assert => {
  assert.throws(() => {
    Object.defineProperty(assert.store.db.jedi, 'yoda', {
      value: yoda,
      writable: false,
    })
  }, /cannot define/)
})

QUnit.test('DatasetProxy: Cannot Set Non Object Value', async assert => {
  assert.throws(() => {
    // @ts-expect-error checking for non object set
    assert.store.db.jedi.yoda = 42
  }, /cannot use non object/)
})

QUnit.test('DatasetProxy: id mismatch', async assert => {
  assert.throws(() => {
    assert.store.db.jedi.yoda = { id: 'joda', name: 'yoda' }
  }, /id mismatch/)
})

QUnit.test('DatasetProxy: delete objects', async assert => {
  assert.deepEqual(assert.store.db.jedi.yoda, undefined, 'start off undefined')
  assert.store.db.jedi.yoda = yoda
  assert.deepEqual(Object.keys(assert.store.db.jedi), ['yoda'], 'now in keys')
  delete assert.store.db.jedi.yoda
  assert.deepEqual(Object.keys(assert.store.db.jedi), [], 'now not in keys')
  assert.deepEqual(assert.store.db.jedi.yoda, undefined, 'not undefined again')
})

QUnit.test('DatasetProxy: delete then recreate', async assert => {
  assert.deepEqual(assert.store.db.jedi.yoda, undefined, 'start off undefined')
  assert.store.db.jedi.yoda = yoda
  assert.deepEqual(assert.store.db.jedi.yoda.name, 'yoda', 'find the name')
  delete assert.store.db.jedi.yoda
  assert.deepEqual(assert.store.db.jedi.yoda, undefined, 'not undefined again')
  assert.store.db.jedi.yoda = yoda
  assert.deepEqual(
    assert.store.db.jedi.yoda.name,
    'yoda',
    'find the name again',
  )
})

QUnit.test('DatasetProxy: delete non-existing', async assert => {
  delete assert.store.db.jedi.yoda
  assert.deepEqual(assert.store.db.jedi.yoda, undefined, 'not undefined')
})

const steps = (fns: any) => {
  let count = 0
  return (...rest: any) => {
    const fn = fns[count]
    if (!fn) {
      console.error(`unexpected step count: ${count}`, ...rest)
      throw new Error(`unexpected step count: ${count}`)
    }
    count++
    return fn(...rest)
  }
}

QUnit.test('Store: Multiple Changes', async assert => {
  const store = assert.store

  let { promise: stepsWait, resolve: stepsDone } = Promise.withResolvers()
  const unmountListener = store.listenChanges(
    steps([
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              id: 'yoda',
              age: 942,
              name: 'yoda',
            },
          },
        })

        store.db.jedi.yoda.age = yoda.age + 1
        assert.equal(
          store.db.jedi.yoda.age,
          yoda.age + 1,
          'expect new yoda age',
        )
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              age: yoda.age + 1,
            },
          },
        })

        store.db.sith.vader = vader
        assert.propContains(store.db.sith.vader, vader, 'expect vader')
      },
      (changes: Changes) => {
        assert.propContains(changes, {
          sith: { vader },
        })

        assert.deepEqual(
          Object.keys(store.db),
          ['jedi', 'sith'],
          'expect both dataset in keys',
        )

        delete store.db.jedi.yoda.age
        assert.notOk(store.db.jedi.yoda.age, 'expect no age')
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              age: undefined,
            },
          },
        })

        assert.propEqual(store.db.jedi, {
          yoda: {
            id: 'yoda',
            name: 'yoda',
          },
        })

        delete store.db.jedi.yoda
        assert.notOk(store.db.jedi.yoda, 'yoda should be deleted')
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              tombstone: true,
            },
          },
        })
        unmountListener()
        stepsDone(undefined)
      },
    ]),
  )

  assert.ok(store.db, 'db exists')
  assert.deepEqual(Object.keys(store.db), [], 'no datasets')
  assert.false('jedi' in store.db, 'jedi dataset doesnt exist yet')
  assert.ok(store.db.jedi, 'a named dataset always exists')
  store.db.jedi.yoda = yoda
  assert.equal(store.db.jedi.yoda.name, yoda.name, 'expect yoda name')
  assert.equal(store.db.jedi.yoda.age, yoda.age, 'expect yoda age')
  assert.equal(store.db.jedi.yoda.id, 'yoda', 'expect yoda id')
  assert.true('jedi' in store.db, 'jedi dataset now exists')
  await stepsWait

  await store.settle()
})
