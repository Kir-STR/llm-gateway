export function renderTemplate(template: string, traceId: string): string {
  return template.replaceAll('{{trace_id_short}}', traceId.slice(0, 8));
}

export function renderNamed(
  templates: Record<string, string>,
  key: string,
  traceId: string,
): string {
  const tpl = templates[key];
  if (tpl === undefined) throw new Error(`Missing template "${key}"`);
  return renderTemplate(tpl, traceId);
}
