import { DigestDeliveryRepository } from "./digest-delivery-repository";
import { isThoughtCaptureEnabled } from "./feature-flags";
import { logInfo } from "./logging";
import { ThoughtRepository } from "./thought-repository";
import type { Env } from "./types";
import { UserPrefsRepository, isDigestDue } from "./user-prefs-repository";

export interface ScheduledHandlerDependencies {
  thoughtRepository: ThoughtRepository;
  userPrefsRepository: UserPrefsRepository;
  digestDeliveryRepository: DigestDeliveryRepository;
}

export function createScheduledHandlerDependencies(): ScheduledHandlerDependencies {
  return {
    thoughtRepository: new ThoughtRepository(),
    userPrefsRepository: new UserPrefsRepository(),
    digestDeliveryRepository: new DigestDeliveryRepository(),
  };
}

/**
 * Digest Scheduler — runs every 15 minutes via Cron Trigger.
 *
 * For each user whose local time matches their configured digest window:
 * 1. Check if a delivery already exists for this period (idempotency)
 * 2. Enqueue a message to the DIGEST_DELIVERY_QUEUE
 *
 * This handler does NOT send Slack messages — only enqueues.
 */
export async function scheduleDigests(
  env: Env,
  deps: ScheduledHandlerDependencies = createScheduledHandlerDependencies()
): Promise<void> {
  if (!isThoughtCaptureEnabled(env)) {
    logInfo("digest.scheduler_skipped", {
      reason: "feature_disabled",
    });
    return;
  }

  const now = new Date();
  const allPrefs = await deps.userPrefsRepository.findAllPrefs(env.DB);

  const dueUsers = allPrefs.filter((prefs) => isDigestDue(prefs, now));

  if (dueUsers.length === 0) {
    logInfo("digest.scheduler_no_users_due", {
      total_users: allPrefs.length,
    });
    return;
  }

  let enqueuedCount = 0;
  let skippedCount = 0;

  for (const prefs of dueUsers) {
    const { periodStart, periodEnd } = computeDigestPeriod(now);

    // Check idempotency — has this user already received a digest for this period?
    const existingDelivery = await deps.digestDeliveryRepository.hasDeliveryForPeriod(
      env.DB,
      prefs.slack_user_id,
      periodStart
    );

    if (existingDelivery) {
      skippedCount++;
      continue;
    }

    await env.DIGEST_DELIVERY_QUEUE.send({
      userId: prefs.slack_user_id,
      periodStart,
      periodEnd,
    });

    enqueuedCount++;
  }

  logInfo("digest.scheduler_complete", {
    total_users: allPrefs.length,
    due_users: dueUsers.length,
    enqueued: enqueuedCount,
    skipped_existing: skippedCount,
  });
}

/**
 * TTL Cleanup — runs daily at 03:00 UTC via Cron Trigger.
 *
 * 1. Purge thought text older than 90 days (set text = NULL)
 * 2. Hard-delete thoughts older than 180 days (except acted_on)
 * 3. Purge old analytics events (retain 180 days)
 */
export async function purgeExpiredThoughts(
  env: Env,
  deps: ScheduledHandlerDependencies = createScheduledHandlerDependencies()
): Promise<void> {
  if (!isThoughtCaptureEnabled(env)) {
    logInfo("ttl.cleanup_skipped", {
      reason: "feature_disabled",
    });
    return;
  }

  const now = Date.now();
  const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff180 = new Date(now - 180 * 24 * 60 * 60 * 1000).toISOString();

  const { textsPurged, recordsDeleted } =
    await deps.thoughtRepository.purgeExpiredText(env.DB, cutoff90, cutoff180);

  // Purge old analytics events
  const analyticsResult = await env.DB
    .prepare(
      `DELETE FROM analytics_events WHERE created_at < ?`
    )
    .bind(cutoff180)
    .run();

  const analyticsDeleted = analyticsResult.meta.changes ?? 0;

  logInfo("ttl.purged", {
    texts_purged: textsPurged,
    records_deleted: recordsDeleted,
    analytics_deleted: analyticsDeleted,
    cutoff_90_days: cutoff90,
    cutoff_180_days: cutoff180,
  });
}

/**
 * Classification Catch-up — runs every 5 minutes via Cron Trigger.
 *
 * Finds stale unclassified thoughts (older than 5 min, younger than 1 hour)
 * and re-enqueues them to the classification queue.
 */
export async function catchUpUnclassified(
  env: Env,
  deps: ScheduledHandlerDependencies = createScheduledHandlerDependencies()
): Promise<void> {
  if (!isThoughtCaptureEnabled(env)) {
    logInfo("classification.catchup_skipped", {
      reason: "feature_disabled",
    });
    return;
  }

  const now = Date.now();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

  const staleThoughts = await deps.thoughtRepository.findStaleUnclassified(
    env.DB,
    fiveMinAgo,
    oneHourAgo
  );

  if (staleThoughts.length === 0) {
    return;
  }

  for (const thought of staleThoughts) {
    await env.CLASSIFICATION_QUEUE.send({
      thoughtId: thought.id,
      userId: thought.slack_user_id,
    });
  }

  logInfo("classification.catchup_enqueued", {
    count: staleThoughts.length,
  });
}

/**
 * Compute the digest period (start and end) for a given moment.
 * The period covers the trailing 7 days ending at the current digest time.
 *
 * periodEnd = current time aligned to the minute
 * periodStart = 7 days before periodEnd
 */
export function computeDigestPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const alignedNow = alignToMinute(now);
  const periodEnd = alignedNow.toISOString();
  const periodStart = new Date(
    alignedNow.getTime() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  return { periodStart, periodEnd };
}

function alignToMinute(now: Date): Date {
  const aligned = new Date(now);
  aligned.setUTCSeconds(0, 0);
  return aligned;
}
