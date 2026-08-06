// src/config.ts
// CoopAtlas Ops — environment + policy configuration.
// Every credential is opt-in via env vars; the service runs degraded (logged)
// when critical credentials are missing, so it can never crash the host app.

export interface OpsConfig {
  // Supabase state store
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;

  // OpenCode Zen (DeepSeek) classifier
  zenBaseUrl: string;
  zenApiKey: string | null;
  zenModel: string;

  // GitHub dispatch
  githubOwner: string;
  githubToken: string | null;

  // WhatsApp (Meta Cloud API)
  whatsappPhoneNumberId: string | null;
  whatsappAccessToken: string | null;
  whatsappVerifyToken: string | null;
  opsAdminPhone: string | null;

  // Secrets for inbound webhooks
  sentryWebhookSecret: string | null;
  callbackToken: string;

  // Escalation
  escalationMinutes: number;
  escalationCron: string;

  // Public base URL used to tell the executor where to call back
  opsBaseUrl: string;
}

export function loadConfig(): OpsConfig {
  return {
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,

    zenBaseUrl: process.env.ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1',
    zenApiKey: process.env.ZEN_API_KEY ?? null,
    zenModel: process.env.ZEN_MODEL ?? 'deepseek-v4-flash',

    githubOwner: process.env.GITHUB_OWNER ?? 'ishameless',
    githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,

    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? null,
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? null,
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? null,
    opsAdminPhone: process.env.OPS_ADMIN_PHONE ?? null,

    sentryWebhookSecret: process.env.SENTRY_WEBHOOK_SECRET ?? null,
    callbackToken: process.env.OPS_CALLBACK_TOKEN ?? 'dev-callback-token',

    escalationMinutes: Number.parseInt(process.env.ESCALATION_MINUTES ?? '30', 10),
    escalationCron: process.env.ESCALATION_CRON ?? '*/10 * * * *',

    opsBaseUrl: process.env.OPS_BASE_URL ?? 'http://localhost:10000/ops',
  };
}

export const config = loadConfig();

/** Repos excluded from auto-patch (always require human approval). */
export const APPROVAL_ONLY_REPOS = new Set<string>(['COOPATLAS_COFFEE']);

/** Project slug → repo mapping, sourced from Sentry project slugs. */
export const PROJECT_TO_REPO: Record<string, string> = {
  'coopatlas-backend': 'coopatlas-backend',
  'coopatlas-mobile': 'coopatlas-mobile',
  'coopatlas-hub-website': 'coopatlas-hub-website',
  'coopatlas-coffee': 'COOPATLAS_COFFEE',
};

/** Log which subsystems are armed so startup is greppable. */
export function logConfigSummary(): void {
  console.log('🤖 CoopAtlas Ops ready.');
  console.log(`   classifier      : ${config.zenApiKey ? `zen/${config.zenModel}` : 'DISABLED (ZEN_API_KEY)'}`);
  console.log(`   github dispatch : ${config.githubToken ? 'armed' : 'DISABLED (GITHUB_TOKEN/GH_TOKEN)'}`);
  console.log(`   whatsapp        : ${config.whatsappAccessToken ? 'armed' : 'DISABLED (WHATSAPP_ACCESS_TOKEN)'}`);
  console.log(`   state store     : ${config.supabaseUrl ? 'supabase' : 'DISABLED (SUPABASE_URL)'}`);
}
