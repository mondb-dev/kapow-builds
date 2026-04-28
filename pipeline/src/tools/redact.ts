/**
 * Best-effort secret redactor for tool outputs.
 *
 * Tool stdout/file reads flow into LLM context AND logs. If the agent reads
 * `.env`, runs `printenv`, or hits a config file, secrets would otherwise
 * be captured permanently. This is defense-in-depth — it cannot catch every
 * exotic secret format, but it suppresses the common ones (cloud keys,
 * bearer tokens, JWTs, basic auth URLs, RSA/SSH keys, KEY=value envs).
 *
 * Patterns prioritize precision over recall: a false positive truncates a
 * benign string to "***REDACTED***", which the agent can usually recover
 * from; a false negative leaks a credential.
 */

const REPLACEMENT = '***REDACTED***';

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // RSA / OpenSSH / PGP private key blocks
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'ssh', re: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+?-----END OPENSSH PRIVATE KEY-----/g },

  // AWS
  { name: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'aws-secret', re: /\baws(.{0,20})?(secret|access).{0,5}['"= :]+([A-Za-z0-9/+=]{40})\b/gi },

  // Google / GCP
  { name: 'gcp-key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: 'gcp-oauth', re: /\bya29\.[0-9A-Za-z_\-]+/g },

  // GitHub
  { name: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },

  // Slack / Stripe / Twilio / SendGrid / OpenAI / Anthropic
  { name: 'slack', re: /\bxox[abprs]-[0-9A-Za-z\-]{10,}\b/g },
  { name: 'stripe', re: /\b(?:sk|rk|pk)_(?:test|live)_[0-9A-Za-z]{16,}\b/g },
  { name: 'sendgrid', re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g },
  { name: 'openai', re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },

  // JWTs (header.payload.signature)
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },

  // Authorization: Bearer / Basic
  { name: 'bearer', re: /\b(authorization|x-api-key|api[_-]?key|api[_-]?token)\s*[:=]\s*['"]?(?:bearer\s+)?[A-Za-z0-9._\-+/=]{16,}/gi },

  // URLs with embedded basic-auth credentials
  { name: 'url-auth', re: /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g },

  // KEY=value lines for env-style secret keys (catches .env / printenv dumps)
  { name: 'env-secret', re: /\b([A-Z_][A-Z0-9_]{2,})\s*=\s*([^\s'"]{8,}|'[^']{8,}'|"[^"]{8,}")/g },
];

// Names that the env-secret pattern should redact only if the key looks
// secret-shaped. We default to redacting and exempt safe ones explicitly.
const ENV_KEY_SAFE = /^(PATH|PWD|HOME|LANG|LC_[A-Z_]+|TERM|SHELL|USER|LOGNAME|TMPDIR|NODE_ENV|npm_[a-z_]+|XDG_[A-Z_]+|EDITOR|VISUAL|HOSTNAME|DISPLAY|MAIL|TZ|COLORTERM)$/i;

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { name, re } of PATTERNS) {
    if (name === 'env-secret') {
      out = out.replace(re, (full, key: string, _val: string) => {
        if (ENV_KEY_SAFE.test(key)) return full;
        return `${key}=${REPLACEMENT}`;
      });
    } else {
      out = out.replace(re, REPLACEMENT);
    }
  }
  return out;
}
