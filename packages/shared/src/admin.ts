import { z } from "zod";
import { AUDIT_ACTION_VALUES } from "./audit.js";
import { BOOKING_STATUS_VALUES } from "./bookings.js";
import { PAYMENT_STATUS_VALUES } from "./payments.js";
import { PROVIDER_STATUS_VALUES, PROVIDER_TYPE_VALUES, publicProviderSchema } from "./providers.js";
import { publicReviewSchema, REVIEW_STATUS_VALUES } from "./reviews.js";
import { ROLES } from "./auth.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const paginationSchema = {
  page: z.coerce.number().int().positive().catch(1),
  pageSize: z.coerce.number().int().positive().max(100).catch(20),
};

// A minimized, operational view of a user account — see
// docs/architecture.md, "Admin & operations — data minimization." Never
// includes email, phone, or anything beyond what the milestone brief
// explicitly calls for (id, display name, role, created date).
export const adminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: z.enum(ROLES).optional(),
  ...paginationSchema,
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminUserListResponseSchema = z.object({
  users: z.array(adminUserSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

export const adminProviderListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(PROVIDER_STATUS_VALUES).optional(),
  providerType: z.enum(PROVIDER_TYPE_VALUES).optional(),
  ...paginationSchema,
});
export type AdminProviderListQuery = z.infer<typeof adminProviderListQuerySchema>;

// Reuses publicProviderSchema as-is — an admin sees exactly the same
// owner-equivalent shape (status, averageRating, reviewCount, etc.) a
// provider owner already sees for their own listing, just across every
// provider rather than just their own.
export const adminProviderListResponseSchema = z.object({
  providers: z.array(publicProviderSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminProviderListResponse = z.infer<typeof adminProviderListResponseSchema>;

// The ONLY field an admin status-change request may contain. Never
// ownerId, businessName, createdAt, or anything else about the provider
// — this endpoint does exactly one thing (see
// apps/api/src/routes/admin/providers.ts).
export const adminProviderStatusSchema = z.object({
  status: z.enum(PROVIDER_STATUS_VALUES),
});
export type AdminProviderStatusInput = z.infer<typeof adminProviderStatusSchema>;

export const adminBookingListQuerySchema = z.object({
  status: z.enum(BOOKING_STATUS_VALUES).optional(),
  providerId: z.string().uuid().optional(),
  paymentStatus: z.enum([...PAYMENT_STATUS_VALUES, "NONE"] as const).optional(),
  dateFrom: z.string().regex(DATE_RE, "dateFrom must be in YYYY-MM-DD format").optional(),
  dateTo: z.string().regex(DATE_RE, "dateTo must be in YYYY-MM-DD format").optional(),
  ...paginationSchema,
});
export type AdminBookingListQuery = z.infer<typeof adminBookingListQuerySchema>;

// A booking's derived "operational" payment status: the SUCCEEDED
// payment if one exists, otherwise the most recent attempt's status,
// otherwise "NONE" if no payment was ever attempted. See
// apps/api/src/lib/admin.ts.
const adminPaymentStatusForBookingSchema = z.enum([...PAYMENT_STATUS_VALUES, "NONE"] as const);

export const adminBookingSummarySchema = z.object({
  id: z.string(),
  customerName: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  serviceName: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  status: z.enum(BOOKING_STATUS_VALUES),
  paymentStatus: adminPaymentStatusForBookingSchema,
  priceMinor: z.number(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminBookingSummary = z.infer<typeof adminBookingSummarySchema>;

export const adminBookingListResponseSchema = z.object({
  bookings: z.array(adminBookingSummarySchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminBookingListResponse = z.infer<typeof adminBookingListResponseSchema>;

export const adminPaymentListQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUS_VALUES).optional(),
  bookingId: z.string().uuid().optional(),
  ...paginationSchema,
});
export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;

// Like publicPaymentSchema, plus providerPaymentId — judged safe for
// operational visibility (it's a correlation id, never a credential or
// signature; see docs/architecture.md, "Admin payment visibility").
export const adminPaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  provider: z.string(),
  providerPaymentId: z.string().nullable(),
  amountMinor: z.number(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUS_VALUES),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminPayment = z.infer<typeof adminPaymentSchema>;

export const adminPaymentListResponseSchema = z.object({
  payments: z.array(adminPaymentSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminPaymentListResponse = z.infer<typeof adminPaymentListResponseSchema>;

export const adminReviewListQuerySchema = z.object({
  status: z.enum(REVIEW_STATUS_VALUES).optional(),
  providerId: z.string().uuid().optional(),
  ...paginationSchema,
});
export type AdminReviewListQuery = z.infer<typeof adminReviewListQuerySchema>;

// Reuses publicReviewSchema — the reviewer identity stays PII-minimized
// (toReviewerDisplayName) even for admins; moderation decisions don't
// require knowing the reviewer's raw name (see docs/architecture.md,
// "Admin & operations — data minimization").
export const adminReviewListResponseSchema = z.object({
  reviews: z.array(publicReviewSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminReviewListResponse = z.infer<typeof adminReviewListResponseSchema>;

export const adminAuditListQuerySchema = z.object({
  action: z.enum(AUDIT_ACTION_VALUES).optional(),
  resourceType: z.string().trim().max(50).optional(),
  ...paginationSchema,
});
export type AdminAuditListQuery = z.infer<typeof adminAuditListQuerySchema>;

// actorName is resolved server-side (a join, never client-supplied) —
// the one place in the admin surface that deliberately shows a full,
// un-minimized account name, because attributing an audit event to a
// real actor IS the point of an audit trail (see docs/architecture.md).
export const adminAuditEntrySchema = z.object({
  id: z.string(),
  actorUserId: z.string(),
  actorName: z.string(),
  action: z.enum(AUDIT_ACTION_VALUES),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  petId: z.string().nullable(),
  providerId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

export const adminAuditListResponseSchema = z.object({
  entries: z.array(adminAuditEntrySchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type AdminAuditListResponse = z.infer<typeof adminAuditListResponseSchema>;

// Every count is a fresh PostgreSQL aggregate at request time — never
// hard-coded, never cached. See apps/api/src/routes/admin/dashboard.ts.
export const adminDashboardSummarySchema = z.object({
  totalCustomers: z.number(),
  totalProviders: z.number(),
  activeProviders: z.number(),
  suspendedProviders: z.number(),
  upcomingBookings: z.number(),
  pendingPayments: z.number(),
  completedBookings: z.number(),
  reviewCount: z.number(),
});
export type AdminDashboardSummary = z.infer<typeof adminDashboardSummarySchema>;
