import { Ajv } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export type StructuredResult = { valid: boolean; value?: unknown; detail?: string };

export function makeStructuredValidator(schema: object): (value: unknown) => StructuredResult {
  const validate = ajv.compile(schema);
  return (value: unknown): StructuredResult => {
    if (validate(value)) return { valid: true, value };
    const detail = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
    return { valid: false, detail };
  };
}
