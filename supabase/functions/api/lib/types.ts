import type { User } from '@supabase/supabase-js';

export type Role = 'admin' | 'editor' | 'viewer';
export type Locale = 'en' | 'de' | 'es' | 'pt' | 'it';

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  is_super_admin: boolean;
  default_org_id: string | null;
  locale: Locale;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  currency: string;
  logo_path: string | null;
  created_at: string;
}

/** Hono context variables set by lib/auth.ts. */
export type AppEnv = {
  Variables: {
    token: string;
    user: User;
    profile: Profile;
    /** Active organization (from the X-Org-Id header, else the profile default). Set by withOrg(). */
    orgId: string;
    /** Effective role in the active organization (super admins are always 'admin'). */
    role: Role;
  };
};

export type LeaseStatus = 'active' | 'expiring' | 'expired' | 'renewed' | 'unknown';
export type DocType = 'main_lease' | 'amendment' | 'addendum' | 'commencement_letter' | 'other';
