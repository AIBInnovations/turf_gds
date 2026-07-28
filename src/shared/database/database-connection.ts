import {
  type ClientSession,
  type Db,
  MongoClient,
  ReadPreference,
  ServerApiVersion,
  type TransactionOptions,
} from 'mongodb';

import type { AppConfig } from '../../config/env.js';

export interface TransactionContext {
  db: Db;
  session: ClientSession;
}

export interface DatabaseConnection {
  readonly db: Db;
  connect(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
  withTransaction<T>(
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T>;
}

const transactionOptions: TransactionOptions = {
  readPreference: ReadPreference.primary,
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  maxCommitTimeMS: 5_000,
};

export class MongoDatabaseConnection implements DatabaseConnection {
  private readonly client: MongoClient;

  public constructor(private readonly config: AppConfig['mongodb']) {
    this.client = new MongoClient(config.uri, {
      maxPoolSize: config.maxPoolSize,
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMs,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
  }

  public get db(): Db {
    return this.client.db(this.config.database);
  }

  public async connect(): Promise<void> {
    await this.client.connect();
    await this.ping();
  }

  public async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public async withTransaction<T>(
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.client.withSession(async (session) =>
      session.withTransaction(
        async () => operation({ db: this.db, session }),
        transactionOptions,
      ),
    );
  }
}
