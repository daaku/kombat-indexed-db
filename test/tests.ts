import { Message, Timestamp } from '@daaku/kombat';
import { deleteDB, IDBPDatabase, openDB } from 'idb';
import { customAlphabet } from 'nanoid';

import {
  Changes,
  LocalIndexedDB,
  syncDatasetIndexedDB,
  syncDatasetMem,
} from '../src';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 10);
const nodeID = 'e35dd11177e4cc2c';
const falconID = '456';
const yodaID = '123';

const falconNameMessage: Message = {
  timestamp: new Timestamp(1599729600000, 0, nodeID).toJSON(),
  dataset: 'spaceship',
  row: falconID,
  column: 'name',
  value: 'Falcon',
} as const;

const yodaNameMessage: Message = {
  timestamp: new Timestamp(1599729700000, 0, nodeID).toJSON(),
  dataset: 'people',
  row: yodaID,
  column: 'name',
  value: 'Yoda',
} as const;

const yodaAge900Message: Message = {
  timestamp: new Timestamp(1599729800000, 0, nodeID).toJSON(),
  dataset: 'people',
  row: yodaID,
  column: 'age',
  value: 900,
} as const;

const yodaAge950Message: Message = {
  timestamp: new Timestamp(1599729900000, 0, nodeID).toJSON(),
  dataset: 'people',
  row: yodaID,
  column: 'age',
  value: 950,
} as const;

function makeName(prefix: string): string {
  return `${prefix}_${nanoid()}`;
}

interface Created {
  l: LocalIndexedDB;
  db: IDBPDatabase;
  cleanUp(): void;
}

async function createDB(
  prefix: string,
  upgradeDB?: (db: IDBPDatabase) => void,
): Promise<Created> {
  const name = makeName(prefix);
  const l = new LocalIndexedDB();
  const db = await openDB(name, 1, {
    upgrade: (db) => {
      l.upgradeDB(db);
      if (upgradeDB) {
        upgradeDB(db);
      }
    },
  });
  l.setDB(db);

  const cleanUp = async () => {
    db.close();
    await deleteDB(name);
  };

  return { l, db, cleanUp };
}

QUnit.test('Set/Get ', async (assert) => {
  const { l, cleanUp } = await createDB('store_query_last_sync');
  const key = 'last_sync';
  assert.notOk(await l.get(key), 'should start off undefined');
  const ts = 'foo-bar-baz';
  await l.set(key, ts);
  assert.equal(await l.get(key), ts, 'should now have expected value');
  await cleanUp();
});

QUnit.test('Store/Query Messages', async (assert) => {
  const { l, cleanUp } = await createDB('store_query_messages');
  const results1 = await l.storeMessages([yodaNameMessage, yodaAge900Message]);
  assert.deepEqual(results1, [true, true], 'both messages should be inserted');
  const results2 = await l.storeMessages([yodaNameMessage, yodaAge900Message]);
  assert.deepEqual(results2, [false, false], 'no messages should be inserted');
  const results3 = await l.queryMessages('');
  assert.deepEqual(
    results3,
    [yodaAge900Message, yodaNameMessage],
    'expect both messages to be returned',
  );
  await cleanUp();
});

QUnit.test('Store/Query Latest', async (assert) => {
  const { l, cleanUp } = await createDB('store_query_latest');
  const originalIn = [yodaNameMessage, yodaAge900Message];
  await l.storeMessages(originalIn);
  assert.deepEqual(
    await l.queryLatestMessages(originalIn),
    originalIn,
    'expect the original set as the latest',
  );
  await l.storeMessages([yodaAge950Message]);
  assert.deepEqual(
    await l.queryLatestMessages(originalIn),
    [yodaNameMessage, yodaAge950Message],
    'now expect the yoda 950 age message',
  );
  await cleanUp();
});

QUnit.test('Sync Dataset IndexedDB', async (assert) => {
  const datasetPrefix = `${nanoid()}_`;
  const upgradeDB = (db: IDBPDatabase) => {
    db.createObjectStore(`${datasetPrefix}people`, { keyPath: 'id' });
    db.createObjectStore(`${datasetPrefix}spaceship`, { keyPath: 'id' });
  };

  const { l, db, cleanUp } = await createDB('apply_messages', upgradeDB);
  l.listenChanges(syncDatasetIndexedDB(db, datasetPrefix));

  await l.applyChanges([falconNameMessage, yodaNameMessage, yodaAge950Message]);
  assert.deepEqual(
    await db.get(`${datasetPrefix}spaceship`, falconID),
    {
      id: falconID,
      name: 'Falcon',
    },
    'expect falcon',
  );
  assert.deepEqual(
    await db.get(`${datasetPrefix}people`, yodaID),
    {
      id: yodaID,
      name: 'Yoda',
      age: 950,
    },
    'expect yoda',
  );
  await cleanUp();
});

QUnit.test('Sync Dataset Mem', async (assert) => {
  const { l, cleanUp } = await createDB('apply_messages');
  const mem = {};
  l.listenChanges(syncDatasetMem(mem));

  await l.applyChanges([falconNameMessage, yodaNameMessage, yodaAge900Message]);
  assert.deepEqual(
    mem,
    {
      [falconNameMessage.dataset]: {
        [falconNameMessage.row]: {
          id: falconNameMessage.row,
          [falconNameMessage.column]: falconNameMessage.value,
        },
      },
      [yodaNameMessage.dataset]: {
        [yodaNameMessage.row]: {
          id: yodaNameMessage.row,
          [yodaNameMessage.column]: yodaNameMessage.value,
          [yodaAge900Message.column]: yodaAge900Message.value,
        },
      },
    },
    'expect mem db',
  );
  await l.applyChanges([yodaAge950Message]);
  assert.deepEqual(
    mem,
    {
      [falconNameMessage.dataset]: {
        [falconNameMessage.row]: {
          id: falconNameMessage.row,
          [falconNameMessage.column]: falconNameMessage.value,
        },
      },
      [yodaNameMessage.dataset]: {
        [yodaNameMessage.row]: {
          id: yodaNameMessage.row,
          [yodaNameMessage.column]: yodaNameMessage.value,
          [yodaAge950Message.column]: yodaAge950Message.value,
        },
      },
    },
    'expect mem db',
  );
  await cleanUp();
});

QUnit.test('Changes', async (assert) => {
  const { l, cleanUp } = await createDB('store_query_latest');
  const changes: Changes[] = [];
  const unsubscribe = l.listenChanges(async (c) => {
    changes.push(c);
  });
  await l.applyChanges([falconNameMessage, yodaAge900Message]);
  await l.applyChanges([yodaAge950Message]);
  unsubscribe();
  await l.applyChanges([yodaNameMessage]);
  assert.deepEqual(
    changes,
    [
      {
        [falconNameMessage.dataset]: {
          [falconNameMessage.row]: {
            [falconNameMessage.column]: falconNameMessage.value,
          },
        },
        [yodaAge900Message.dataset]: {
          [yodaAge900Message.row]: {
            [yodaAge900Message.column]: yodaAge900Message.value,
          },
        },
      },
      {
        [yodaAge950Message.dataset]: {
          [yodaAge950Message.row]: {
            [yodaAge950Message.column]: yodaAge950Message.value,
          },
        },
      },
    ],
    'expect some changes',
  );
  await cleanUp();
});
