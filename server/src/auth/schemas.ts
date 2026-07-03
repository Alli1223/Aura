import { z } from 'zod';

// A handful of very common passwords that would otherwise satisfy the length
// policy. Length is the primary control; this just blocks the worst offenders.
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '1q2w3e4r5t6y',
  'adminadmin',
  'iloveyou123',
  'letmein123',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'q1w2e3r4t5y6',
  'qwertyuiop',
  'qwerty123456',
  'welcome123',
]);

export const usernameSchema = z
  .string('Username is required')
  .trim()
  .toLowerCase()
  .min(3, 'Username must be between 3 and 32 characters')
  .max(32, 'Username must be between 3 and 32 characters')
  .regex(
    /^[a-z0-9._-]+$/,
    'Username may only contain letters, numbers, dots, underscores and hyphens',
  );

export const passwordSchema = z
  .string('Password is required')
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((password) => !COMMON_PASSWORDS.has(password.toLowerCase()), {
    message: 'Password is too common',
  });

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Invalid email address'));

export const registerBodySchema = z.object({
  username: usernameSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

// Deliberately looser than registration: normalise the username the same way
// but do not leak the registration policy through login validation errors.
export const loginBodySchema = z.object({
  username: z.string('Username is required').trim().toLowerCase().min(1, 'Username is required'),
  password: z.string('Password is required').min(1, 'Password is required').max(1024),
});
export type LoginBody = z.infer<typeof loginBodySchema>;
