import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
    dbMock: { select: vi.fn() },
}));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/db/schema", () => ({
    emailCampaigns: {
        id: "id",
        slug: "slug",
        subject: "subject",
        kind: "kind",
        createdAt: "created_at",
    },
    emailDeliveries: {
        id: "id",
        campaignId: "campaign_id",
        status: "status",
    },
    emailSuppressions: {
        email: "email",
        reason: "reason",
        note: "note",
        createdAt: "created_at",
    },
    newsletterSubscriptions: {
        confirmedAt: "confirmed_at",
        unsubscribedAt: "unsubscribed_at",
    },
}));

import {
    countCampaigns,
    listCampaignsOverview,
    newsletterStats,
    suppressionCountsByReason,
} from "@/db/queries/admin-email";

function stubGroupedSelect(rows: Record<string, unknown>[]) {
    dbMock.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue(rows),
                    }),
                }),
            }),
            groupBy: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue(rows),
            }),
        }),
    });
}

function stubPlainSelect(rows: Record<string, unknown>[]) {
    dbMock.select.mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
    });
}

describe("listCampaignsOverview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("reconciles unknown delivery statuses into an 'other' bucket instead of dropping them", async () => {
        // attempted=10, but sent+failed+skipped+pending only account for 7 --
        // the missing 3 must land in `other`, not vanish.
        stubGroupedSelect([
            {
                id: "c1",
                slug: "welcome",
                subject: "Welcome to Riffado",
                kind: "transactional",
                createdAt: new Date("2024-01-01"),
                attempted: 10,
                sent: 5,
                failed: 1,
                skipped: 1,
                pending: 0,
            },
        ]);

        const [row] = await listCampaignsOverview(50);
        expect(row.other).toBe(3);
        expect(
            row.sent + row.failed + row.skipped + row.pending + row.other,
        ).toBe(row.attempted);
    });

    it("normalizes an unrecognized DB kind to 'marketing' rather than trusting the cast", async () => {
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        stubGroupedSelect([
            {
                id: "c1",
                slug: "weird",
                subject: "Weird",
                kind: "not-a-real-kind",
                createdAt: new Date(),
                attempted: 0,
                sent: 0,
                failed: 0,
                skipped: 0,
                pending: 0,
            },
        ]);

        const [row] = await listCampaignsOverview(50);
        errorSpy.mockRestore();
        expect(row.kind).toBe("marketing");
    });

    it("never reports a negative 'other' count", async () => {
        // Pathological input (shouldn't happen -- filters are subsets of
        // attempted -- but guard against a future miscount going negative).
        stubGroupedSelect([
            {
                id: "c1",
                slug: "overcounted",
                subject: "Overcounted",
                kind: "marketing",
                createdAt: new Date(),
                attempted: 2,
                sent: 5,
                failed: 0,
                skipped: 0,
                pending: 0,
            },
        ]);

        const [row] = await listCampaignsOverview(50);
        expect(row.other).toBe(0);
    });
});

describe("countCampaigns", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 0 for an empty table instead of throwing on undefined", async () => {
        stubPlainSelect([]);
        const n = await countCampaigns();
        expect(n).toBe(0);
    });

    it("returns the row count", async () => {
        stubPlainSelect([{ n: 7 }]);
        const n = await countCampaigns();
        expect(n).toBe(7);
    });
});

describe("suppressionCountsByReason", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("maps reason/count pairs", async () => {
        stubGroupedSelect([
            { reason: "bounce", n: 12 },
            { reason: "unsubscribe", n: 4 },
        ]);
        const rows = await suppressionCountsByReason();
        expect(rows).toEqual([
            { reason: "bounce", n: 12 },
            { reason: "unsubscribe", n: 4 },
        ]);
    });
});

describe("newsletterStats", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("defaults every field to 0 when the table is empty", async () => {
        stubPlainSelect([]);
        const stats = await newsletterStats();
        expect(stats).toEqual({ total: 0, confirmed: 0, unsubscribed: 0 });
    });

    it("passes through counts", async () => {
        stubPlainSelect([{ total: 100, confirmed: 60, unsubscribed: 10 }]);
        const stats = await newsletterStats();
        expect(stats).toEqual({ total: 100, confirmed: 60, unsubscribed: 10 });
    });
});
