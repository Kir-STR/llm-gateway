import { createGateway } from '@kir-str/llm-gateway';
import { loadConfigFile } from '@kir-str/llm-gateway/node';
import type { GatewayConfig, LlmCaller, TelemetrySink } from '@kir-str/llm-gateway';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfigFile(join(here, 'gateway.config.yaml')) as GatewayConfig;

const llm: LlmCaller = {
  async call() {
    return {
      text: 'This is a fake reply.',
      structured: { answer: 'ok', confidence: 0.8 },
      usage: { inputTokens: 12, outputTokens: 8 },
    };
  },
};
const telemetry: TelemetrySink = {
  event: (e) => console.log(`[${e.event}]`, JSON.stringify(e.data)),
};

const gateway = createGateway(config, { llm, telemetry });

for (const input of ['Hello, how are you?', 'contact me at a@b.com']) {
  const result = await gateway.runTurn(input);
  console.log(
    'RESULT:',
    JSON.stringify(
      { outcome: result.outcome, kind: result.kind, scenario: result.scenario, text: result.text },
      null,
      2,
    ),
  );
}
await gateway.close();
