/**
 * Persistence port.
 *
 * Every method is async so that non-SQLite backends (Cloudflare D1, Turso,
 * HTTP-based data APIs) can implement the same contract.
 */
import type {
  AdminKeyRecord,
  AdminUserRecord,
  ApiUserRecord,
  DestinationRecord,
  InstalledAddonRecord,
  RecordQuery,
  RelayDeliveryRecord,
  RelayDeliveryStats,
  RelayRecord,
  WebhookRecord,
} from "./types";

export interface DestinationStore {
  create(destination: DestinationRecord): Promise<void>;
  update(destination: DestinationRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<DestinationRecord | null>;
  findByInboundUuid(uuid: string): Promise<DestinationRecord | null>;
  findByFetchUuid(uuid: string): Promise<DestinationRecord | null>;
  list(): Promise<readonly DestinationRecord[]>;
  countUsingAddon(addonName: string): Promise<number>;
}

export interface RecordStore {
  insert(record: WebhookRecord): Promise<void>;
  /** Reads matching records ordered by descending `t` without side effects. */
  query(query: RecordQuery): Promise<readonly WebhookRecord[]>;
  /**
   * Reads matching records and marks them fetched inside one transaction, so
   * concurrent `only_unfetched` readers cannot both claim the same record.
   */
  queryAndMark(query: RecordQuery): Promise<readonly WebhookRecord[]>;
  countForDestination(destinationId: string): Promise<number>;
  /** Deletes records past their retention window; returns the deleted count. */
  deleteExpired(
    nowSeconds: number,
    defaultRetentionSeconds: number,
  ): Promise<number>;
  deleteForDestination(destinationId: string): Promise<number>;
}

export interface ApiUserStore {
  create(user: ApiUserRecord): Promise<void>;
  update(user: ApiUserRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<ApiUserRecord | null>;
  list(): Promise<readonly ApiUserRecord[]>;
  /** `createdAt` is unix seconds supplied by the caller's clock. */
  grant(
    userId: string,
    destinationId: string,
    createdAt: number,
  ): Promise<void>;
  revoke(userId: string, destinationId: string): Promise<void>;
  listGrants(userId: string): Promise<readonly string[]>;
  hasGrant(userId: string, destinationId: string): Promise<boolean>;
}

export interface AdminKeyStore {
  create(key: AdminKeyRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<AdminKeyRecord | null>;
  list(): Promise<readonly AdminKeyRecord[]>;
}

export interface AdminUserStore {
  upsert(user: AdminUserRecord): Promise<void>;
  delete(subject: string): Promise<boolean>;
  findBySubject(subject: string): Promise<AdminUserRecord | null>;
  list(): Promise<readonly AdminUserRecord[]>;
}

export interface InstalledAddonStore {
  create(addon: InstalledAddonRecord): Promise<void>;
  delete(name: string): Promise<boolean>;
  findByName(name: string): Promise<InstalledAddonRecord | null>;
  list(): Promise<readonly InstalledAddonRecord[]>;
}

export interface RelayStore {
  create(relay: RelayRecord): Promise<void>;
  update(relay: RelayRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<RelayRecord | null>;
  list(): Promise<readonly RelayRecord[]>;
  listForDestination(destinationId: string): Promise<readonly RelayRecord[]>;
  /** Enabled relays only; used on the inbound path. */
  listEnabledForDestination(
    destinationId: string,
  ): Promise<readonly RelayRecord[]>;
}

export interface RelayDeliveryStore {
  enqueue(delivery: RelayDeliveryRecord): Promise<void>;
  /**
   * Claims up to `limit` due deliveries inside one transaction, incrementing
   * their attempt counter and pushing `nextAttemptAt` past the lease window, so
   * concurrent workers cannot claim the same job twice.
   */
  claimDue(
    nowSeconds: number,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly RelayDeliveryRecord[]>;
  markDelivered(
    id: string,
    nowSeconds: number,
    statusCode: number | null,
  ): Promise<void>;
  /** Keeps the delivery pending and schedules the next attempt. */
  reschedule(
    id: string,
    nowSeconds: number,
    nextAttemptAt: number,
    statusCode: number | null,
    error: string,
  ): Promise<void>;
  /**
   * Parks a claimed delivery without consuming an attempt: the claim
   * incremented the counter, so parking gives it back.
   */
  park(
    id: string,
    nowSeconds: number,
    nextAttemptAt: number,
    reason: string,
  ): Promise<void>;
  /** Gives up on the delivery after the final attempt. */
  markFailed(
    id: string,
    nowSeconds: number,
    statusCode: number | null,
    error: string,
  ): Promise<void>;
  /** Moves every failed delivery of a relay back into the queue. */
  requeueFailed(relayId: string, nowSeconds: number): Promise<number>;
  /**
   * Deletes deliveries past the retention window of their destination, using
   * the same rules as `RecordStore.deleteExpired`: a per-destination
   * `retentionSeconds` overrides the default, and a window of zero or less
   * disables deletion.
   *
   * A delivery carries a copy of the record's payload, so retention must reach
   * it. Terminal deliveries (`delivered` and `failed`) are always removed. A
   * `pending` delivery is kept regardless of age - deleting a job that is still
   * queued would silently drop an undelivered webhook - unless its relay is
   * disabled or gone, in which case it is parked indefinitely and would
   * otherwise outlive the retention window forever.
   */
  deleteExpired(
    nowSeconds: number,
    defaultRetentionSeconds: number,
  ): Promise<number>;
  listForRelay(
    relayId: string,
    limit: number,
  ): Promise<readonly RelayDeliveryRecord[]>;
  statsForRelay(relayId: string): Promise<RelayDeliveryStats>;
}

export interface PersistenceAdapter {
  readonly destinations: DestinationStore;
  readonly records: RecordStore;
  readonly apiUsers: ApiUserStore;
  readonly adminKeys: AdminKeyStore;
  readonly adminUsers: AdminUserStore;
  readonly addons: InstalledAddonStore;
  readonly relays: RelayStore;
  readonly relayDeliveries: RelayDeliveryStore;
  /** Creates the schema when missing. Safe to call repeatedly. */
  init(): Promise<void>;
  close(): Promise<void>;
}
