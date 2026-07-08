import type { Guard, Verdict } from '../core/types.js';
import type { GuardConfig } from '../core/config-schema.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RU_PHONE_RE = /(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/g;

export function createPiiGuard(cfg: GuardConfig): Guard {
  const rules = (cfg.rules as string[] | undefined) ?? ['ru_phone', 'email'];
  const mask = (cfg.mask as Record<string, string> | undefined) ?? {};
  const route = cfg.route as string | undefined;
  return {
    name: cfg.name,
    phase: 'input',
    deterministic: true,
    transforms: true,
    timeoutMs: cfg.timeout_ms,
    run(ctx): Verdict {
      let text = ctx.input.text;
      let email = false;
      let phone = false;
      EMAIL_RE.lastIndex = 0;
      if (rules.includes('email') && EMAIL_RE.test(text)) {
        email = true;
        text = text.replace(EMAIL_RE, mask.email ?? '[EMAIL_MASKED]');
      }
      RU_PHONE_RE.lastIndex = 0;
      if (rules.includes('ru_phone') && RU_PHONE_RE.test(text)) {
        phone = true;
        text = text.replace(RU_PHONE_RE, mask.ru_phone ?? '[PHONE_MASKED]');
      }
      const evidence = { email, phone };
      if (!email && !phone) return { outcome: 'PASS', evidence };
      const verdict: Verdict = { outcome: 'PASS', transform: text, evidence };
      if (route) verdict.route = route;
      return verdict;
    },
  };
}
