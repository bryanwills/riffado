/**
 * Regression coverage for `upsertSubscription`'s handling of the
 * `subscriptions_user_id_active_unique` partial unique index (at most one
 * live subscription per user).
 *
 * Two Stripe webhooks racing on the same user can both hit this index: the
 * first insert/update wins, the second collides. `upsertSubscription`
 * resolves the collision by looking up the currently-live subscription for
 * that user:
 *
 *   - If a *different* subscription is still live, that's a genuine
 *     out-of-order-webhook conflict -- throw `SubscriptionUserConflictError`
 *     so the caller (`mirror.ts`) can re-mirror the stale row from Stripe
 *     and retry.
 *   - If no conflicting row is found, the race already resolved itself
 *     between the failed insert and this lookup (a concurrent webhook
 *     cleared/replaced the blocking row) -- retry the upsert once instead
 *     of re-throwing the raw postgres driver error, which embeds the full
 *     parameterized SQL statement (Stripe customer id, price id, amount)
 *     and would otherwise leak into error tracking as an unhandled
 *     failure (see PostHog issue with fingerprint
 *     fd4b8e92...0cd8c38026b41ef8975754971710a3c3918b05c66578ebb82a6a2623ab77c8e0cc73d428).
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        insert: vi.fn(),
        select: vi.fn(),
    },
}));

import { db } from "@/db";
import {
    SubscriptionUserConflictError,
    upsertSubscription,
} from "@/db/queries/billing";

const uniqueViolation = () =>
    Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: "subscriptions_user_id_active_unique",
    });

/** Queues successive resolutions/rejections for `db.insert(...).values(...).onConflictDoUpdate(...)`. */
function stubInsert(...results: Array<"ok" | Error>) {
    const onConflictDoUpdate = vi.fn();
    for (const result of results) {
        if (result === "ok") {
            onConflictDoUpdate.mockImplementationOnce(async () => undefined);
        } else {
            onConflictDoUpdate.mockImplementationOnce(async () => {
                throw result;
            });
        }
    }
    (db.insert as unknown as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate }),
    });
    return onConflictDoUpdate;
}

/** Stubs `db.select().from().where().orderBy().limit()` used by `getSubscriptionByUserId`. */
function stubSelect(rows: Array<Record<string, unknown>>) {
    (db.select as unknown as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(rows),
                }),
            }),
        }),
    });
}

const baseInput = {
    id: "sub_new",
    userId: "u1",
    stripeCustomerId: "cus_1",
    stripePriceId: "price_1",
    status: "active",
    amountValue: "5.00",
    amountCurrency: "USD",
    interval: "1 month",
    description: null,
    billingCountry: "US",
    startDate: new Date("2026-07-22T00:00:00Z"),
    nextPaymentAt: null,
    canceledAt: null,
    metadata: {},
};

describe("upsertSubscription", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("succeeds on the first attempt when there is no conflict", async () => {
        const onConflictDoUpdate = stubInsert("ok");

        await expect(upsertSubscription(baseInput)).resolves.toBeUndefined();

        expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
        expect(db.select).not.toHaveBeenCalled();
    });

    it("throws SubscriptionUserConflictError when a different subscription is still live", async () => {
        const onConflictDoUpdate = stubInsert(uniqueViolation());
        stubSelect([{ id: "sub_other", userId: "u1", status: "active" }]);

        const error = await upsertSubscription(baseInput).catch((e) => e);

        expect(error).toBeInstanceOf(SubscriptionUserConflictError);
        expect(error).toMatchObject({
            userId: "u1",
            conflictingSubscriptionId: "sub_other",
        });
        // Never retries the raw insert once a genuine conflict is found --
        // the caller must re-mirror the conflicting row first.
        expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    });

    it("retries once and succeeds when the conflict already resolved itself", async () => {
        const onConflictDoUpdate = stubInsert(uniqueViolation(), "ok");
        // No live row for this user by the time we look -- the blocking
        // row was cleared/replaced by a concurrent webhook.
        stubSelect([]);

        await expect(upsertSubscription(baseInput)).resolves.toBeUndefined();

        expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    });

    it("does not swallow the raw driver error if the retry itself fails", async () => {
        const conflictError = uniqueViolation();
        const onConflictDoUpdate = stubInsert(conflictError, uniqueViolation());
        stubSelect([]);

        await expect(upsertSubscription(baseInput)).rejects.toThrow(
            /duplicate key value violates unique constraint/,
        );
        expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    });

    it("rethrows unrelated errors immediately without looking up a conflict", async () => {
        const connectionError = new Error("connection terminated");
        const onConflictDoUpdate = stubInsert(connectionError);

        await expect(upsertSubscription(baseInput)).rejects.toThrow(
            "connection terminated",
        );

        expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
        expect(db.select).not.toHaveBeenCalled();
    });
});
