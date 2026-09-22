import { z } from "zod";

export const ROLES = [
  "PET_PARENT",
  "VET",
  "GROOMER",
  "BOARDING_PROVIDER",
  "ADMIN",
] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

// Registration never accepts a client-supplied role. The server always
// assigns PET_PARENT for public self-registration.
export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Invalid email address").max(255),
  phone: z.string().trim().min(7, "Phone number is too short").max(20),
  // bcrypt silently truncates input beyond 72 bytes, so the max is
  // enforced here to avoid a surprising truncation vulnerability.
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required").max(72),
});

export type LoginInput = z.infer<typeof loginSchema>;

// The shape returned to clients. Never includes passwordHash.
export const publicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const authErrorSchema = z.object({
  error: z.string(),
});

export type AuthError = z.infer<typeof authErrorSchema>;
