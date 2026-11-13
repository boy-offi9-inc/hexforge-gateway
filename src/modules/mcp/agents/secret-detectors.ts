import { createHash } from "node:crypto";

/**
 * Multi-detector secret-candidate model for `scan-secrets`.
 *
 * A candidate is (detector, file, line, match). The secret value itself is
 * never stored anywhere: the candidate carries a redacted preview (first 4
 * characters plus the match length) and a SHA-256 of the full match, which
 * lets two runs on the same file dedupe without ever persisting the secret.
 *
 * Confidence is a heuristic, not a verdict: each detector declares how
 * distinctive its pattern shape is, then generic evidence (entropy, nearby
 * keywords, placeholder/example shapes) adjusts it. Placeholder values like
 * `AKIAIOSFODNN7EXAMPLE` (the AWS docs key) are high-entropy and look real
 * to any prefix rule, so detectors keep an explicit examples list instead
 * of pretending the heuristics catch them.
 */

export interface SecretCandidate {
  detector: string;
  file: string;
  line: number;
  /** Line content, trimmed, with the matched secret fully redacted. */
  context: string;
  /** First 4 characters of the match, for human recognition. */
  preview: string;
  /** Length of the full match in characters. */
  length: number;
  /** SHA-256 of the full match - stable id for dedupe, never reversible. */
  fingerprint: string;
  confidence: "low" | "medium" | "high";
  /** Why this confidence: one short reason per signal that fired. */
  signals: string[];
}

export interface Detector {
  name: string;
  pattern: RegExp;
  /** Base confidence from how distinctive the pattern shape is. */
  base: "low" | "medium" | "high";
  /** Words that, if present on the line, raise confidence one notch. */
  keywords?: string[];
  /** Lowercase shapes that are almost always fixtures, not secrets. */
  placeholders?: string[];
}

export const DETECTORS: Detector[] = [
  {
    name: "AWS Access Key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    base: "high",
    keywords: ["aws", "access_key", "accesskey", "secret_access_key"],
    placeholders: ["akiaiosfodnn7example"],
  },
  {
    name: "AWS Secret Access Key",
    pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    base: "low",
    keywords: ["aws_secret_access_key", "secret_access_key", "awssecretkey"],
  },
  {
    name: "Google API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    base: "high",
    keywords: ["google", "api_key", "apikey", "firebase"],
    placeholders: ["aizasyaexampleplaceholder2345678"],
  },
  {
    name: "GCP OAuth Client",
    pattern: /[0-9]+-[0-9a-z]{32}\.apps\.googleusercontent\.com/gi,
    base: "medium",
    keywords: ["google", "client_id", "oauth"],
  },
  {
    name: "Azure Storage Key",
    pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{88}==(?![A-Za-z0-9+/=])/g,
    base: "medium",
    keywords: ["azure", "storage", "account_key", "connection"],
  },
  {
    name: "Private Key Header",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    base: "high",
  },
  {
    name: "GitHub Token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,255}/g,
    base: "high",
    keywords: ["github", "token", "gh"],
    placeholders: ["ghp_000000000000000000000000000000000000"],
  },
  {
    name: "GitHub App Token",
    pattern: /(ghr|ghs)_[A-Za-z0-9]{76}/g,
    base: "high",
  },
  {
    name: "GitLab Token",
    pattern: /glpat-[0-9A-Za-z\-_]{20,}/g,
    base: "high",
    keywords: ["gitlab", "token"],
  },
  {
    name: "Slack Token",
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,48}/g,
    base: "high",
    keywords: ["slack", "token", "bot"],
  },
  {
    name: "Slack Webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z_]+\/B[0-9A-Za-z_]+\/[0-9A-Za-z]+/g,
    base: "high",
  },
  {
    name: "Stripe Secret Key",
    pattern: /[sr]k_live_[0-9a-zA-Z]{20,}/g,
    base: "high",
    keywords: ["stripe", "key"],
  },
  {
    name: "Stripe Webhook Secret",
    pattern: /whsec_[0-9a-zA-Z]{24,}/g,
    base: "high",
  },
  {
    name: "Twilio API Key",
    pattern: /SK[0-9a-fA-F]{32}/g,
    base: "medium",
    keywords: ["twilio", "sid", "api"],
  },
  {
    name: "SendGrid API Key",
    pattern: /SG\.[0-9A-Za-z\-_]{16,32}\.[0-9A-Za-z\-_]{16,64}/g,
    base: "high",
    keywords: ["sendgrid", "key"],
  },
  {
    name: "Mailgun API Key",
    pattern: /key-[0-9a-zA-Z]{32}/g,
    base: "medium",
    keywords: ["mailgun", "key"],
  },
  {
    name: "JWT",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    base: "medium",
    keywords: ["token", "authorization", "bearer", "jwt"],
  },
  {
    name: "Firebase Cloud Messaging Key",
    pattern: /AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}/g,
    base: "high",
    keywords: ["firebase", "fcm", "messaging"],
  },
  {
    name: "NPM Token",
    pattern: /npm_[0-9A-Za-z]{36}/g,
    base: "high",
    keywords: ["npm", "token"],
  },
  {
    name: "PyPI Token",
    pattern: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g,
    base: "high",
  },
  {
    name: "Hex-encoded 32-byte Key",
    pattern: /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g,
    base: "low",
    keywords: ["secret", "key", "hash", "signing", "hmac", "encryption"],
  },
  {
    name: "Base64 32-byte Key",
    pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g,
    base: "low",
    keywords: ["secret", "key", "signing", "hmac", "encryption"],
  },
  {
    name: "Generic Bearer Token",
    pattern: /[Bb]earer\s+[A-Za-z0-9\-_.~+/]+=*/g,
    base: "low",
    keywords: ["authorization", "auth", "token"],
  },
  {
    name: "Password Assignment",
    pattern: /(?:[Pp]assword|[Pp]asswd|[Pp]wd)\s*[=:]\s*["']?[^\s"',;]{8,}/g,
    base: "low",
  },
];

const RANK: Record<SecretCandidate["confidence"], number> = { low: 0, medium: 1, high: 2 };
const ORDER = ["low", "medium", "high"] as const;

function rank(r: SecretCandidate["confidence"]): number {
  return RANK[r];
}

function fromRank(n: number): SecretCandidate["confidence"] {
  const clamped = Math.max(0, Math.min(2, n));
  return ORDER[clamped];
}

/**
 * Shannon entropy in bits per character. Uniform random strings land near
 * log2(alphabet size); English words and repeated shapes land well below.
 * Thresholds are deliberately soft - they are one signal among several.
 */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLACEHOLDER_WORDS = [
  "example",
  "placeholder",
  "changeme",
  "change_me",
  "dummy",
  "sample",
  "xxxxx",
  "your_",
  "your-",
  "todo",
  "insert_",
  "fixme",
  "test123",
  "123456",
  "abcdef",
];

function isPlaceholder(match: string, placeholders?: string[]): string | undefined {
  const lower = match.toLowerCase();
  if (placeholders?.some((p) => lower.includes(p))) return "detector placeholder list";
  if (PLACEHOLDER_WORDS.some((w) => lower.includes(w))) return "placeholder wording";
  if (/^0+$|^1+$|^a+$/.test(lower) && lower.length >= 8) return "repeated-character filler";
  return undefined;
}

export function detect(
  file: string,
  lines: string[],
  detectors: Detector[] = DETECTORS,
): SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = detector.pattern.exec(line)) !== null) {
        const match = m[0];
        if (match.length < 6) continue;
        const signals: string[] = [];
        let score = rank(detector.base);

        const placeholder = isPlaceholder(match, detector.placeholders);
        if (placeholder) {
          signals.push(`placeholder: ${placeholder}`);
          score = 0;
        } else {
          const ent = entropy(match);
          if (ent >= 4.5) {
            signals.push(`high entropy (${ent.toFixed(1)} bits/char)`);
            score += 1;
          } else if (ent < 2.5) {
            signals.push(`low entropy (${ent.toFixed(1)} bits/char)`);
            score -= 1;
          } else {
            signals.push(`entropy ${ent.toFixed(1)} bits/char`);
          }
          const keyword = detector.keywords?.find((k) => lower.includes(k));
          if (keyword) {
            signals.push(`context keyword "${keyword}"`);
            score += 1;
          }
        }

        const lineText = line.trim();
        const start = m.index;
        const redacted =
          lineText.slice(0, Math.max(0, start - (line.length - lineText.length))) +
          `[REDACTED:${match.length}]` +
          lineText.slice(Math.max(0, start - (line.length - lineText.length)) + match.length);

        candidates.push({
          detector: detector.name,
          file,
          line: i + 1,
          context: redacted.slice(0, 300),
          preview: match.slice(0, 4),
          length: match.length,
          fingerprint: createHash("sha256").update(match).digest("hex"),
          confidence: fromRank(score),
          signals,
        });
      }
    }
  }
  return candidates;
}
