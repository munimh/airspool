import type { FailureUpdate, NewChange, OutboxCounts, OutboxStore, StoredChange } from "../store.ts";

const copy = (change: StoredChange): StoredChange => structuredClone(change);

/**
 * An {@link OutboxStore} that keeps everything in memory. Changes are lost
 * when the process ends, so use it for tests and local experiments only.
 *
 * Several outboxes in one process can share one memory store; the lease
 * then works between them just as it does across processes with Postgres.
 */
export function memoryStore(): OutboxStore {
  const changes = new Map<number, StoredChange>();
  const leases = new Map<string, { owner: string; expiresAt: number }>();
  let lastId = 0;

  const inQueue = (queue: string) => [...changes.values()].filter((c) => c.queue === queue);
  const pick = (queue: string, ids: number[] | "all") =>
    inQueue(queue).filter((c) => c.status === "failed" && (ids === "all" || ids.includes(c.id)));

  return {
    insert(change: NewChange) {
      const stored: StoredChange = {
        ...structuredClone(change),
        id: ++lastId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: change.createdAt,
        lastError: null,
        sentAt: null,
      };
      changes.set(stored.id, stored);
      return Promise.resolve(copy(stored));
    },

    acquireLease(queue, owner, expiresAt, now) {
      const held = leases.get(queue);
      if (held && held.owner !== owner && held.expiresAt > now) return Promise.resolve(false);
      leases.set(queue, { owner, expiresAt });
      return Promise.resolve(true);
    },

    renewLease(queue, owner, expiresAt) {
      const held = leases.get(queue);
      if (held?.owner !== owner) return Promise.resolve(false);
      held.expiresAt = expiresAt;
      return Promise.resolve(true);
    },

    releaseLease(queue, owner) {
      if (leases.get(queue)?.owner === owner) leases.delete(queue);
      return Promise.resolve();
    },

    loadDue(queue, now, maxGroups) {
      const groups = new Map<string, StoredChange[]>();
      for (const c of inQueue(queue).sort((a, b) => a.id - b.id)) {
        if (c.status !== "pending") continue;
        const list = groups.get(c.groupKey) ?? [];
        list.push(c);
        groups.set(c.groupKey, list);
      }
      const due = [...groups.values()]
        .filter((list) => list.every((c) => c.nextAttemptAt <= now))
        .slice(0, maxGroups)
        .flat()
        .sort((a, b) => a.id - b.id);
      return Promise.resolve(due.map(copy));
    },

    loadSentAfter(queue, groupKeys, afterId) {
      const keys = new Set(groupKeys);
      return Promise.resolve(
        inQueue(queue)
          .filter((c) => c.status === "sent" && c.id > afterId && keys.has(c.groupKey))
          .sort((a, b) => a.id - b.id)
          .map(copy),
      );
    },

    markSent(ids, now) {
      for (const id of ids) {
        const c = changes.get(id);
        if (!c) continue;
        c.status = "sent";
        c.sentAt = now;
        c.attempts += 1;
        c.lastError = null;
      }
      return Promise.resolve();
    },

    recordFailure(ids, update: FailureUpdate) {
      for (const id of ids) {
        const c = changes.get(id);
        if (!c) continue;
        c.status = update.status;
        c.attempts = update.attempts;
        c.nextAttemptAt = update.nextAttemptAt;
        c.lastError = update.error;
      }
      return Promise.resolve();
    },

    retry(queue, ids, now) {
      const list = pick(queue, ids);
      for (const c of list) {
        c.status = "pending";
        c.attempts = 0;
        c.nextAttemptAt = now;
        c.lastError = null;
      }
      return Promise.resolve(list.length);
    },

    discard(queue, ids) {
      const list = pick(queue, ids);
      for (const c of list) changes.delete(c.id);
      return Promise.resolve(list.length);
    },

    counts(queue) {
      const out: OutboxCounts = { pending: 0, retrying: 0, failed: 0 };
      for (const c of inQueue(queue)) {
        if (c.status === "failed") out.failed++;
        else if (c.status === "pending") c.attempts === 0 ? out.pending++ : out.retrying++;
      }
      return Promise.resolve(out);
    },

    listFailed(queue, limit) {
      return Promise.resolve(
        inQueue(queue).filter((c) => c.status === "failed").sort((a, b) => a.id - b.id).slice(0, limit).map(copy),
      );
    },

    purgeSent(queue, before) {
      const failedGroups = new Set(inQueue(queue).filter((c) => c.status === "failed").map((c) => c.groupKey));
      let removed = 0;
      for (const c of inQueue(queue)) {
        if (c.status === "sent" && c.sentAt !== null && c.sentAt < before && !failedGroups.has(c.groupKey)) {
          changes.delete(c.id);
          removed++;
        }
      }
      return Promise.resolve(removed);
    },
  };
}
